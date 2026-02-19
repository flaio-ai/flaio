import net from "node:net";
import fs from "node:fs";
import { appStore, getSessionInstance } from "../store/app-store.js";
import type { AgentSession } from "../agents/agent-session.js";
import type { ScreenContent } from "../terminal/screen-buffer.js";
import {
  PORTAL_SOCKET_DIR,
  PORTAL_SOCKET_PATH,
  type PortalClientMsg,
  type PortalServerMsg,
  type PortalSessionInfo,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Per-client state
// ---------------------------------------------------------------------------

interface PortalClient {
  socket: net.Socket;
  subscribedSessionId: string | null;
  /** Unsubscribe from AgentSession "content" event */
  contentUnsub: (() => void) | null;
  /** Unsubscribe from AgentSession "status" event */
  statusUnsub: (() => void) | null;
  /** Throttle timer handle */
  throttleTimer: ReturnType<typeof setTimeout> | null;
  /** Pending frame waiting to be sent (throttle coalescing) */
  pendingFrame: PortalServerMsg | null;
}

const MIN_FRAME_INTERVAL_MS = 50; // 20fps cap

// ---------------------------------------------------------------------------
// PortalServer
// ---------------------------------------------------------------------------

export class PortalServer {
  private server: net.Server | null = null;
  private clients = new Map<net.Socket, PortalClient>();
  private storeUnsub: (() => void) | null = null;

  async start(): Promise<void> {
    fs.mkdirSync(PORTAL_SOCKET_DIR, { recursive: true });

    // Remove stale socket file
    try {
      fs.unlinkSync(PORTAL_SOCKET_PATH);
    } catch {
      // Doesn't exist — fine
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((conn) => {
        this.handleConnection(conn);
      });

      this.server.on("error", reject);
      this.server.listen(PORTAL_SOCKET_PATH, () => {
        fs.chmodSync(PORTAL_SOCKET_PATH, 0o600);
        this.watchSessionRemovals();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.storeUnsub) {
      this.storeUnsub();
      this.storeUnsub = null;
    }

    // Clean up all clients
    for (const [socket, client] of this.clients) {
      this.cleanupClient(client);
      socket.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        try {
          fs.unlinkSync(PORTAL_SOCKET_PATH);
        } catch {
          // Best effort
        }
      } else {
        resolve();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private handleConnection(socket: net.Socket): void {
    const client: PortalClient = {
      socket,
      subscribedSessionId: null,
      contentUnsub: null,
      statusUnsub: null,
      throttleTimer: null,
      pendingFrame: null,
    };
    this.clients.set(socket, client);

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: PortalClientMsg = JSON.parse(line);
          this.handleMessage(client, msg);
        } catch {
          this.send(client, { type: "portal_error", message: "Invalid JSON" });
        }
      }
    });

    socket.on("close", () => {
      this.cleanupClient(client);
      this.clients.delete(socket);
    });

    socket.on("error", () => {
      this.cleanupClient(client);
      this.clients.delete(socket);
    });
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  private handleMessage(client: PortalClient, msg: PortalClientMsg): void {
    switch (msg.type) {
      case "portal_list":
        this.handleList(client);
        break;
      case "portal_subscribe":
        this.handleSubscribe(client, msg.sessionId);
        break;
      case "portal_input":
        this.handleInput(client, msg.data);
        break;
      case "portal_unsubscribe":
        this.handleUnsubscribe(client);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private handleList(client: PortalClient): void {
    const sessions: PortalSessionInfo[] = appStore
      .getState()
      .sessions.map((s) => ({
        id: s.id,
        driverName: s.driverName,
        displayName: s.displayName,
        cwd: s.cwd,
        status: s.status,
      }));
    this.send(client, { type: "portal_sessions", sessions });
  }

  private handleSubscribe(client: PortalClient, sessionId: string): void {
    // Clean up any previous subscription
    this.cleanupSubscription(client);

    const session = getSessionInstance(sessionId);
    if (!session) {
      this.send(client, {
        type: "portal_error",
        message: `Session "${sessionId}" not found`,
      });
      return;
    }

    client.subscribedSessionId = sessionId;

    // Send initial frame immediately
    this.sendFrame(client, session);

    // Subscribe to content updates (throttled to 20fps)
    const onContent = (_content: ScreenContent, _cursor: { x: number; y: number }) => {
      this.scheduleFrame(client, session);
    };
    session.on("content", onContent);
    client.contentUnsub = () => session.removeListener("content", onContent);

    // Subscribe to status updates
    const onStatus = (status: string) => {
      this.send(client, {
        type: "portal_status",
        sessionId,
        status,
      });
    };
    session.on("status", onStatus);
    client.statusUnsub = () => session.removeListener("status", onStatus);
  }

  private handleInput(client: PortalClient, data: string): void {
    if (!client.subscribedSessionId) return;
    const session = getSessionInstance(client.subscribedSessionId);
    if (session) {
      session.write(data);
    }
  }

  private handleUnsubscribe(client: PortalClient): void {
    this.cleanupSubscription(client);
  }

  // -------------------------------------------------------------------------
  // Frame sending with throttle + backpressure
  // -------------------------------------------------------------------------

  private sendFrame(client: PortalClient, session: AgentSession): void {
    const content = session.getContent();
    const cursor = session.getCursorPos();
    const msg: PortalServerMsg = {
      type: "portal_frame",
      content,
      cursor,
      cols: session.cols,
      rows: session.rows,
    };
    this.send(client, msg);
  }

  private scheduleFrame(client: PortalClient, session: AgentSession): void {
    // Coalesce: always update pending frame to latest
    const content = session.getContent();
    const cursor = session.getCursorPos();
    client.pendingFrame = {
      type: "portal_frame",
      content,
      cursor,
      cols: session.cols,
      rows: session.rows,
    };

    // If a timer is already running, the pending frame will be sent when it fires
    if (client.throttleTimer) return;

    client.throttleTimer = setTimeout(() => {
      client.throttleTimer = null;
      if (client.pendingFrame) {
        this.send(client, client.pendingFrame);
        client.pendingFrame = null;
      }
    }, MIN_FRAME_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // Watch for session removals via appStore
  // -------------------------------------------------------------------------

  private watchSessionRemovals(): void {
    let prevIds = new Set(appStore.getState().sessions.map((s) => s.id));

    this.storeUnsub = appStore.subscribe((state) => {
      const currentIds = new Set(state.sessions.map((s) => s.id));

      // Check for removed sessions
      for (const id of prevIds) {
        if (!currentIds.has(id)) {
          // Notify all subscribed clients
          for (const client of this.clients.values()) {
            if (client.subscribedSessionId === id) {
              this.send(client, {
                type: "portal_session_ended",
                sessionId: id,
              });
              this.cleanupSubscription(client);
            }
          }
        }
      }

      prevIds = currentIds;
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private send(client: PortalClient, msg: PortalServerMsg): void {
    // Backpressure: skip frame messages if the socket buffer is full
    if (client.socket.writableNeedDrain && msg.type === "portal_frame") {
      return;
    }
    client.socket.write(JSON.stringify(msg) + "\n");
  }

  private cleanupSubscription(client: PortalClient): void {
    if (client.contentUnsub) {
      client.contentUnsub();
      client.contentUnsub = null;
    }
    if (client.statusUnsub) {
      client.statusUnsub();
      client.statusUnsub = null;
    }
    if (client.throttleTimer) {
      clearTimeout(client.throttleTimer);
      client.throttleTimer = null;
    }
    client.pendingFrame = null;
    client.subscribedSessionId = null;
  }

  private cleanupClient(client: PortalClient): void {
    this.cleanupSubscription(client);
  }
}
