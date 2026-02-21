import { EventEmitter } from "node:events";
import {
  RELAY_URL,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  type CliToRelayMsg,
  type RelayToCliMsg,
} from "./relay-protocol.js";
import {
  setRelayConnectionStatus,
  updateViewerCount,
  clearViewerCounts,
} from "./relay-store.js";
import { appStore, getSessionInstance } from "../store/app-store.js";
import { settingsStore } from "../store/settings-store.js";
import type { AgentSession } from "../agents/agent-session.js";

import { makeDebugLog } from "../connectors/debug.js";

const debugLog = makeDebugLog("relay");

// ---------------------------------------------------------------------------
// Per-session tracking
// ---------------------------------------------------------------------------

interface TrackedSession {
  sessionId: string;
  rawDataUnsub: (() => void) | null;
  statusUnsub: (() => void) | null;
}

// ---------------------------------------------------------------------------
// Replay buffer — ring buffer of recent PTY output per session
// ---------------------------------------------------------------------------

class ReplayBuffer {
  private buffers = new Map<string, string[]>();
  private sizes = new Map<string, number>();
  private maxBytes: number;

  constructor(maxKB: number) {
    this.maxBytes = maxKB * 1024;
  }

  push(sessionId: string, data: string): void {
    let chunks = this.buffers.get(sessionId);
    let size = this.sizes.get(sessionId) ?? 0;

    if (!chunks) {
      chunks = [];
      this.buffers.set(sessionId, chunks);
    }

    chunks.push(data);
    size += data.length;

    // Evict oldest chunks when over budget
    while (size > this.maxBytes && chunks.length > 1) {
      const removed = chunks.shift()!;
      size -= removed.length;
    }

    this.sizes.set(sessionId, size);
  }

  get(sessionId: string): string[] {
    return this.buffers.get(sessionId) ?? [];
  }

  remove(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.sizes.delete(sessionId);
  }

  clear(): void {
    this.buffers.clear();
    this.sizes.clear();
  }
}

// ---------------------------------------------------------------------------
// RelayClient
// ---------------------------------------------------------------------------

export class RelayClient extends EventEmitter {
  private ws: import("ws").WebSocket | null = null;
  private trackedSessions = new Map<string, TrackedSession>();
  private replayBuffer: ReplayBuffer;
  private storeUnsub: (() => void) | null = null;

  // Reconnection state
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = false;

  // Heartbeat state
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  private started = false;

  constructor() {
    super();
    const maxKB = settingsStore.getState().config.relay.maxReplayBufferKB;
    this.replayBuffer = new ReplayBuffer(maxKB);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;

    this.watchSessions();
    await this.connect();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.shouldReconnect = false;

    if (this.storeUnsub) {
      this.storeUnsub();
      this.storeUnsub = null;
    }

    this.clearReconnectTimer();
    this.clearHeartbeat();

    // Untrack all sessions
    for (const tracked of this.trackedSessions.values()) {
      this.untrackSession(tracked);
    }
    this.trackedSessions.clear();
    this.replayBuffer.clear();
    clearViewerCounts();

    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }

    setRelayConnectionStatus("disconnected");
  }

  // -------------------------------------------------------------------------
  // WebSocket connection
  // -------------------------------------------------------------------------

  private async connect(): Promise<void> {
    const token = settingsStore.getState().config.relay.authToken;
    if (!token) {
      debugLog("relay: no auth token — skipping connect");
      setRelayConnectionStatus("disconnected");
      return;
    }

    setRelayConnectionStatus("connecting");

    try {
      // Dynamic import — ws is a dependency we expect to be available
      const { default: WebSocket } = await import("ws");

      this.ws = new WebSocket(RELAY_URL);

      this.ws.on("open", () => {
        debugLog("relay: connected to relay server");
        setRelayConnectionStatus("authenticating");
        this.send({ type: "cli_auth", token: token! });
        this.startHeartbeat();
      });

      this.ws.on("message", (raw) => {
        try {
          const msg: RelayToCliMsg = JSON.parse(raw.toString());
          this.handleMessage(msg);
        } catch {
          debugLog("relay: invalid message from relay");
        }
      });

      this.ws.on("close", (code) => {
        debugLog(`relay: disconnected (code ${code})`);
        this.ws = null;
        this.clearHeartbeat();
        clearViewerCounts();

        if (this.shouldReconnect) {
          setRelayConnectionStatus("disconnected");
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (err) => {
        debugLog(`relay: WebSocket error: ${err.message}`);
        setRelayConnectionStatus("error", err.message);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: failed to connect: ${message}`);
      setRelayConnectionStatus("error", message);

      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private handleMessage(msg: RelayToCliMsg): void {
    switch (msg.type) {
      case "relay_auth_ok":
        debugLog("relay: authenticated");
        setRelayConnectionStatus("connected");
        this.reconnectAttempt = 0;
        // Register all current sessions
        this.registerAllSessions();
        break;

      case "relay_auth_fail":
        debugLog(`relay: auth failed: ${msg.reason}`);
        setRelayConnectionStatus("error", `Auth failed: ${msg.reason}`);
        // Don't reconnect on auth failure — token is bad
        this.shouldReconnect = false;
        break;

      case "relay_input":
        this.handleRelayInput(msg.sessionId, msg.data);
        break;

      case "relay_resize":
        this.handleRelayResize(msg.sessionId, msg.cols, msg.rows);
        break;

      case "relay_viewer_joined":
        debugLog(`relay: viewer ${msg.viewerId} joined session ${msg.sessionId}`);
        updateViewerCount(msg.sessionId, 1);
        break;

      case "relay_viewer_left":
        debugLog(`relay: viewer ${msg.viewerId} left session ${msg.sessionId}`);
        updateViewerCount(msg.sessionId, -1);
        break;

      case "relay_create_session":
        this.handleRelayCreateSession(msg.driverName, msg.cwd);
        break;

      case "relay_ping":
        this.send({ type: "cli_pong" });
        this.resetPongTimer();
        break;
    }
  }

  private handleRelayInput(sessionId: string, base64Data: string): void {
    const shareMode = settingsStore.getState().config.relay.defaultShareMode;
    if (shareMode === "read-only") {
      debugLog(`relay: ignoring input for ${sessionId} (read-only mode)`);
      return;
    }

    const session = getSessionInstance(sessionId);
    if (!session) return;

    const data = Buffer.from(base64Data, "base64").toString("utf-8");
    session.scrollToBottom();
    session.write(data);
  }

  private handleRelayResize(sessionId: string, cols: number, rows: number): void {
    const session = getSessionInstance(sessionId);
    if (!session) return;
    session.resize(cols, rows);
  }

  private handleRelayCreateSession(driverName: string, cwd: string): void {
    const session = appStore.getState().createSession(driverName, cwd);
    if (session) {
      session.start();
    }
  }

  // -------------------------------------------------------------------------
  // Session tracking — watch appStore for session add/remove
  // -------------------------------------------------------------------------

  private watchSessions(): void {
    let prevIds = new Set(appStore.getState().sessions.map((s) => s.id));

    // Track existing sessions
    for (const s of appStore.getState().sessions) {
      this.trackSession(s.id);
    }

    this.storeUnsub = appStore.subscribe((state) => {
      const currentIds = new Set(state.sessions.map((s) => s.id));

      // New sessions
      for (const id of currentIds) {
        if (!prevIds.has(id)) {
          this.trackSession(id);
          this.registerSession(id);
        }
      }

      // Removed sessions
      for (const id of prevIds) {
        if (!currentIds.has(id)) {
          const tracked = this.trackedSessions.get(id);
          if (tracked) {
            this.untrackSession(tracked);
            this.trackedSessions.delete(id);
          }
          this.replayBuffer.remove(id);
          this.send({ type: "cli_unregister_session", sessionId: id });
        }
      }

      prevIds = currentIds;
    });
  }

  private trackSession(sessionId: string): void {
    if (this.trackedSessions.has(sessionId)) return;

    const session = getSessionInstance(sessionId);
    if (!session) return;

    const tracked: TrackedSession = {
      sessionId,
      rawDataUnsub: null,
      statusUnsub: null,
    };

    // Stream raw PTY data to relay
    tracked.rawDataUnsub = session.onRawData((data: string) => {
      this.replayBuffer.push(sessionId, data);
      const base64 = Buffer.from(data, "utf-8").toString("base64");
      this.send({ type: "cli_pty_data", sessionId, data: base64 });
    });

    // Forward status changes
    const onStatus = (status: string) => {
      this.send({ type: "cli_session_status", sessionId, status });
    };
    session.on("status", onStatus);
    tracked.statusUnsub = () => session.removeListener("status", onStatus);

    this.trackedSessions.set(sessionId, tracked);
  }

  private untrackSession(tracked: TrackedSession): void {
    if (tracked.rawDataUnsub) {
      tracked.rawDataUnsub();
      tracked.rawDataUnsub = null;
    }
    if (tracked.statusUnsub) {
      tracked.statusUnsub();
      tracked.statusUnsub = null;
    }
  }

  // -------------------------------------------------------------------------
  // Session registration — send current sessions to relay
  // -------------------------------------------------------------------------

  private registerAllSessions(): void {
    for (const s of appStore.getState().sessions) {
      this.registerSession(s.id);
    }
  }

  private registerSession(sessionId: string): void {
    const sessionState = appStore.getState().sessions.find((s) => s.id === sessionId);
    const instance = getSessionInstance(sessionId);
    if (!sessionState || !instance) return;

    this.send({
      type: "cli_register_session",
      sessionId,
      driverName: sessionState.driverName,
      displayName: sessionState.displayName,
      cwd: sessionState.cwd,
      status: sessionState.status,
      cols: instance.cols,
      rows: instance.rows,
    });
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.clearHeartbeat();
    // We respond to server pings. Reset the pong timer on each ping.
    this.resetPongTimer();
  }

  private resetPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      debugLog("relay: no ping from relay — connection dead");
      if (this.ws) {
        this.ws.close(4000, "Ping timeout");
      }
    }, PING_INTERVAL_MS + PONG_TIMEOUT_MS);
  }

  private clearHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection with exponential backoff
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)]!;
    this.reconnectAttempt++;

    debugLog(`relay: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Send helper
  // -------------------------------------------------------------------------

  private send(msg: CliToRelayMsg): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return;

    // Backpressure: drop PTY data if buffer is backing up
    if (msg.type === "cli_pty_data" && this.ws.bufferedAmount > 256 * 1024) {
      return;
    }

    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      debugLog("relay: send error");
    }
  }
}
