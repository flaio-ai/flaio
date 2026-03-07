import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  DEFAULT_DRIVER_NAME,
  type CliToRelayMsg,
  type RelayToCliMsg,
  type RelayStartPlanningMsg,
  type RelayStartInteractivePlanningMsg,
  type RelayStartImplementationMsg,
  type RelayRequestChangesMsg,
} from "./relay-protocol.js";
import { ticketTracker } from "./ticket-tracker.js";
import { createWorktree, autoSaveAllWorktrees } from "./worktree-manager.js";
import {
  setRelayConnectionStatus,
  setSessionEncryptionStatus,
  updateViewerCount,
  clearViewerCounts,
  setSessionOrgSettings,
  getAnyOrgSettings,
  setWorktreeDefaults,
} from "./relay-store.js";
import { refreshAuthToken } from "./relay-auth.js";
import { appStore, getSessionInstance } from "../store/app-store.js";
import { settingsStore } from "../store/settings-store.js";
import { getAllDrivers } from "../agents/agent-registry.js";
import type { AgentSession } from "../agents/agent-session.js";
import {
  generateSessionKeyPair,
  generateSessionContentKey,
  importPeerPublicKey,
  deriveKeyEncryptionKey,
  wrapSessionContentKey,
  encryptData,
  decryptData,
  type SessionKeyPair,
  type SessionContentKey,
} from "./relay-crypto.js";

import { makeDebugLog } from "../connectors/debug.js";
import { RelayToCliMsgSchema } from "./relay-message-schemas.js";
import { RateLimiter } from "./rate-limiter.js";
import { sessionMetadataStore } from "../agents/session-metadata.js";

const debugLog = makeDebugLog("relay");

// ---------------------------------------------------------------------------
// Per-session tracking
// ---------------------------------------------------------------------------

interface ViewerCryptoState {
  kek: CryptoKey;
  keyDelivered: boolean;
}

interface TrackedSession {
  sessionId: string;
  rawDataUnsub: (() => void) | null;
  statusUnsub: (() => void) | null;
  /** ECDH key pair for this session (null when E2E disabled) */
  keyPair: SessionKeyPair | null;
  /** Session Content Key — encrypts all PTY data (null when E2E disabled) */
  sck: SessionContentKey | null;
  /** Per-viewer KEK state */
  viewerKeys: Map<string, ViewerCryptoState>;
  /** Monotonic sequence counter for encrypted PTY data ordering */
  encryptSeq: number;
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

  // Rate limiters
  private inputLimiter = new RateLimiter(30, 30); // 30 inputs/sec per key
  private browseLimiter = new RateLimiter(10, 10); // 10 browse requests/sec
  private createSessionLimiter = new RateLimiter(1, 0.2); // 1 per 5 seconds

  constructor() {
    super();
    const maxKB = settingsStore.getState().config.relay.maxReplayBufferKB;
    this.replayBuffer = new ReplayBuffer(maxKB);
  }

  private get e2eEnabled(): boolean {
    return settingsStore.getState().config.relay.e2eEncryption;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;

    await this.watchSessions();
    await this.connect();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.shouldReconnect = false;

    // Auto-save all worktrees before shutting down
    const projectCwds = ticketTracker.getTrackedProjectCwds();
    for (const cwd of projectCwds) {
      await autoSaveAllWorktrees(cwd).catch((err) =>
        debugLog(`relay: worktree auto-save failed for ${cwd}: ${err}`),
      );
    }

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
    this.inputLimiter.clear();
    this.browseLimiter.clear();
    this.createSessionLimiter.clear();

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

      const relayUrl = process.env.RELAY_URL || settingsStore.getState().config.relay.relayUrl;
      this.ws = new WebSocket(relayUrl);

      this.ws.on("open", () => {
        debugLog("relay: connected to relay server");
        setRelayConnectionStatus("authenticating");
        this.send({ type: "cli_auth", token: token! });
        this.startHeartbeat();
      });

      this.ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          const result = RelayToCliMsgSchema.safeParse(parsed);
          if (!result.success) {
            debugLog(`relay: invalid message schema: ${result.error.message}`);
            return;
          }
          this.handleMessage(result.data);
        } catch {
          debugLog("relay: invalid JSON from relay");
        }
      });

      this.ws.on("close", (code) => {
        debugLog(`relay: disconnected (code ${code})`);
        this.ws = null;
        this.clearHeartbeat();
        clearViewerCounts();

        // Clear viewer keys on disconnect — viewers must re-handshake
        for (const tracked of this.trackedSessions.values()) {
          tracked.viewerKeys.clear();
        }

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
        // Try refreshing the token before giving up
        this.handleAuthFailure();
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
        this.cleanupViewerCrypto(msg.sessionId, msg.viewerId);
        this.browseLimiter.removeKey(msg.viewerId);
        this.inputLimiter.removeKey(msg.viewerId);
        break;

      case "relay_create_session":
        this.handleRelayCreateSession(msg.driverName, msg.cwd);
        break;

      case "relay_browse_dir":
        this.handleBrowseDir(msg.requestId, msg.viewerId, msg.path);
        break;

      case "relay_browse_files":
        this.handleBrowseFiles(msg.requestId, msg.viewerId, msg.path);
        break;

      case "relay_ping":
        this.send({ type: "cli_pong" });
        this.resetPongTimer();
        break;

      case "relay_viewer_public_key":
        this.handleViewerPublicKey(msg.sessionId, msg.viewerId, msg.publicKey);
        break;

      case "relay_encrypted_input":
        this.handleEncryptedInput(msg.sessionId, msg.viewerId, msg.data);
        break;

      case "relay_start_planning":
        this.handleStartPlanning(msg);
        break;

      case "relay_start_interactive_planning":
        this.handleStartInteractivePlanning(msg);
        break;

      case "relay_start_implementation":
        this.handleStartImplementation(msg);
        break;

      case "relay_request_changes":
        this.handleRequestChanges(msg);
        break;

      case "relay_request_git_info":
        this.handleRequestGitInfo(msg.requestId, msg.viewerId, msg.cwd);
        break;

      case "relay_close_session":
        debugLog(`relay: close session request for ${msg.sessionId}`);
        appStore.getState().closeSession(msg.sessionId);
        break;

      case "relay_list_drivers":
        this.handleListDrivers(msg.viewerId);
        break;

      case "relay_user_settings":
        this.handleUserSettings(msg);
        break;

      case "relay_repo_detected":
        this.handleRepoDetected(msg);
        break;
    }
  }

  private async handleAuthFailure(): Promise<void> {
    debugLog("relay: attempting token refresh...");
    const newToken = await refreshAuthToken();
    if (newToken) {
      debugLog("relay: token refreshed, reconnecting");
      this.reconnectAttempt = 0;
      this.scheduleReconnect();
    } else {
      debugLog("relay: token refresh failed — giving up");
      this.shouldReconnect = false;
    }
  }

  private handleRelayInput(sessionId: string, base64Data: string): void {
    const shareMode = settingsStore.getState().config.relay.defaultShareMode;
    if (shareMode === "read-only") {
      debugLog(`relay: ignoring input for ${sessionId} (read-only mode)`);
      return;
    }

    if (!this.inputLimiter.allow(sessionId)) {
      debugLog(`relay: rate limited input for ${sessionId}`);
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

  private resolveCwd(cwd: string): string {
    if (cwd.startsWith("~/")) {
      return cwd.replace("~", process.env.HOME ?? os.homedir());
    }
    if (cwd === "~") {
      return process.env.HOME ?? os.homedir();
    }
    return cwd;
  }

  private handleRelayCreateSession(driverName: string, cwd: string): void {
    if (!this.createSessionLimiter.allow("global")) {
      debugLog("relay: rate limited session creation");
      return;
    }

    const resolvedCwd = this.resolveCwd(cwd);

    debugLog(`relay: create session request: driver=${driverName} cwd=${resolvedCwd}`);
    try {
      const session = appStore.getState().createSession(driverName, resolvedCwd);
      if (session) {
        session.start().catch((err) => debugLog(`relay: session start failed: ${err}`));
      } else {
        debugLog(`relay: createSession returned null (driver "${driverName}" not found?)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: failed to create session: ${message}`);
    }
  }

  private handleRepoDetected(msg: RelayToCliMsg & { type: "relay_repo_detected" }): void {
    debugLog(
      `relay: repo detected session=${msg.sessionId} org=${msg.orgName} repo=${msg.repoFullName}`,
    );

    setSessionOrgSettings(msg.sessionId, {
      orgId: msg.orgId,
      orgName: msg.orgName,
      repoId: msg.repoId,
      repoName: msg.repoName,
      repoFullName: msg.repoFullName,
      settings: msg.settings,
      enforced: msg.enforced,
    });

    this.emit("repo_detected", {
      sessionId: msg.sessionId,
      orgId: msg.orgId,
      orgName: msg.orgName,
      repoFullName: msg.repoFullName,
      settings: msg.settings,
      enforced: msg.enforced,
    });
  }

  private handleUserSettings(msg: RelayToCliMsg & { type: "relay_user_settings" }): void {
    debugLog("relay: received user settings");
    setWorktreeDefaults(msg.worktreeDefaults);

    // Sync to local config file
    settingsStore.getState().update({
      worktree: msg.worktreeDefaults,
    });
  }

  private async handleListDrivers(viewerId: string): Promise<void> {
    const allDrivers = getAllDrivers();
    const drivers = await Promise.all(
      allDrivers.map(async (d) => ({
        name: d.name,
        displayName: d.displayName,
        installed: await d.checkInstalled(),
        models: d.listModels(),
      })),
    );
    this.send({ type: "cli_drivers_result", viewerId, drivers });
  }

  private async handleBrowseDir(requestId: string, viewerId: string, dirPath: string): Promise<void> {
    if (!this.browseLimiter.allow(viewerId)) {
      debugLog(`relay: rate limited browse dir from ${viewerId}`);
      this.send({
        type: "cli_browse_dir_result",
        requestId,
        viewerId,
        resolvedPath: dirPath,
        directories: [],
        error: "Rate limited — try again",
      });
      return;
    }

    const resolvedPath = this.resolveCwd(dirPath);

    try {
      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      const directories = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      this.send({
        type: "cli_browse_dir_result",
        requestId,
        viewerId,
        resolvedPath: path.resolve(resolvedPath),
        directories,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: browse dir failed: ${message}`);
      this.send({
        type: "cli_browse_dir_result",
        requestId,
        viewerId,
        resolvedPath: path.resolve(resolvedPath),
        directories: [],
        error: message,
      });
    }
  }

  private async handleBrowseFiles(requestId: string, viewerId: string, dirPath: string): Promise<void> {
    if (!this.browseLimiter.allow(viewerId)) {
      debugLog(`relay: rate limited browse files from ${viewerId}`);
      this.send({
        type: "cli_browse_files_result",
        requestId,
        viewerId,
        resolvedPath: dirPath,
        directories: [],
        files: [],
        error: "Rate limited — try again",
      });
      return;
    }

    const resolvedPath = this.resolveCwd(dirPath);

    try {
      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      const directories = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      const files = entries
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      this.send({
        type: "cli_browse_files_result",
        requestId,
        viewerId,
        resolvedPath: path.resolve(resolvedPath),
        directories,
        files,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: browse files failed: ${message}`);
      this.send({
        type: "cli_browse_files_result",
        requestId,
        viewerId,
        resolvedPath: path.resolve(resolvedPath),
        directories: [],
        files: [],
        error: message,
      });
    }
  }

  private async handleRequestGitInfo(requestId: string, viewerId: string, cwd: string): Promise<void> {
    const resolvedPath = this.resolveCwd(cwd);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const execGit = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync("git", args, {
        cwd: resolvedPath,
        timeout: 5000,
      });
      return stdout.trim();
    };

    try {
      // Run git commands in parallel
      const [branchResult, remoteResult, logResult, statusResult] = await Promise.allSettled([
        execGit(["rev-parse", "--abbrev-ref", "HEAD"]),
        execGit(["remote", "get-url", "origin"]),
        execGit(["log", "--format=%H%n%s%n%an%n%ct", "-5"]),
        execGit(["status", "--porcelain"]),
      ]);

      const branch = branchResult.status === "fulfilled" ? branchResult.value : null;
      const remoteUrl = remoteResult.status === "fulfilled" ? remoteResult.value : null;

      // Parse commits from git log output
      const commits: { hash: string; message: string; author: string; timestamp: number }[] = [];
      if (logResult.status === "fulfilled" && logResult.value) {
        const lines = logResult.value.split("\n");
        for (let i = 0; i + 3 < lines.length; i += 4) {
          commits.push({
            hash: lines[i]!,
            message: lines[i + 1]!,
            author: lines[i + 2]!,
            timestamp: parseInt(lines[i + 3]!, 10),
          });
        }
      }

      // Parse status output
      const statusOutput = statusResult.status === "fulfilled" ? statusResult.value : "";
      const changedFiles = statusOutput ? statusOutput.split("\n").filter(Boolean).length : 0;
      const isClean = changedFiles === 0;

      this.send({
        type: "cli_git_info_result",
        requestId,
        viewerId,
        branch,
        remoteUrl,
        commits,
        changedFiles,
        isClean,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: git info failed: ${message}`);
      this.send({
        type: "cli_git_info_result",
        requestId,
        viewerId,
        branch: null,
        remoteUrl: null,
        commits: [],
        changedFiles: 0,
        isClean: true,
        error: message,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3: Ticket dev-loop handlers
  // -------------------------------------------------------------------------

  private async handleStartPlanning(msg: RelayStartPlanningMsg): Promise<void> {
    const resolvedCwd = this.resolveCwd(msg.cwd);
    const iteration = msg.iteration ?? 0;

    // --- Worktree resolution ---
    let effectiveCwd = resolvedCwd;
    let worktreePath: string | null = null;
    let branchName: string | null = null;

    if (msg.useWorktree) {
      // Reuse existing worktree if one exists for this ticket
      const existingWt = ticketTracker.getWorktreeInfo(msg.ticketId);
      if (existingWt?.worktreePath) {
        effectiveCwd = existingWt.worktreePath;
        worktreePath = existingWt.worktreePath;
        branchName = existingWt.branchName;
      } else {
        const wt = await createWorktree(resolvedCwd, msg.ticketId);
        if (wt) {
          effectiveCwd = wt.worktreePath;
          worktreePath = wt.worktreePath;
          branchName = wt.branchName;
        }
      }
    }

    const orgSettings = getAnyOrgSettings();
    const orgInstructions = orgSettings?.settings.systemInstructions?.map((i) => i.content) ?? [];
    const allInstructions = [...new Set([...orgInstructions, ...msg.systemInstructions])];

    const promptParts = [
      "You are planning the implementation of a ticket.",
      "",
      `Title: ${msg.ticketTitle}`,
      `Description: ${msg.ticketDescription}`,
      "",
      ...allInstructions.map((i) => `System Instruction:\n${i}`),
      "",
    ];

    if (msg.previousPlan && msg.feedback) {
      promptParts.push(
        "A previous plan was created but the user requested revisions.",
        "",
        "Previous Plan:",
        msg.previousPlan,
        "",
        "User Feedback:",
        msg.feedback,
        "",
        "Revise the plan based on the feedback above.",
      );
    } else {
      promptParts.push(
        "Analyze the requirements and create a detailed implementation plan.",
      );
    }

    promptParts.push(
      "",
      "The plan must include:",
      "- Files to create/modify",
      "- Key implementation steps with code snippets where helpful",
      "- Any potential issues or considerations",
      "",
      "IMPORTANT: Output ONLY the complete plan. Do NOT add a summary, introduction, or conclusion.",
      "Your entire output will be captured and shown to the user as the plan.",
    );

    const planningPrompt = promptParts.join("\n");

    const driverName = msg.driverName || DEFAULT_DRIVER_NAME;
    debugLog(`relay: start planning ticket=${msg.ticketId} iteration=${iteration} cwd=${effectiveCwd} driver=${driverName}${branchName ? ` branch=${branchName}` : ""}`);

    try {
      const session = appStore.getState().createSession(driverName, effectiveCwd);
      if (!session) {
        debugLog("relay: failed to create planning session");
        return;
      }

      ticketTracker.startPlanning(msg.ticketId, session.id, msg.ticketTitle, resolvedCwd, worktreePath, branchName);

      this.send({
        type: "cli_ticket_status",
        ticketId: msg.ticketId,
        sessionId: session.id,
        status: "planning",
        branchName: branchName ?? undefined,
      });

      // Accumulate raw PTY output for plan capture.
      // We can't rely on xterm buffer because the app-store's exit listener
      // calls kill() → xterm.dispose() before we can read it.
      let rawOutput = "";
      const rawUnsub = session.onRawData((data) => {
        rawOutput += data;
      });

      session.start({
        prompt: planningPrompt,
        mode: "print",
        allowedTools: ["Read", "Glob", "Grep", "Bash(git *)"],
        model: msg.model,
      }).catch((err) => debugLog(`relay: planning session start failed: ${err}`));

      // Set session metadata so clients know this is non-interactive
      const command = `${driverName} -p "<planning prompt>"`;
      appStore.getState().setSessionMeta(session.id, { interactive: false, command });
      this.registerSession(session.id);

      // In print mode, claude -p exits when done — listen for exit
      const onExit = () => {
        rawUnsub();
        // Strip ANSI escape sequences from raw PTY output
        const plainText = rawOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();

        ticketTracker.updateStatus(msg.ticketId, "plan_ready");

        this.send({
          type: "cli_plan_ready",
          ticketId: msg.ticketId,
          sessionId: session.id,
          plan: plainText,
          iteration,
          feedback: msg.feedback ?? null,
          branchName: branchName ?? undefined,
        });

        this.send({
          type: "cli_ticket_status",
          ticketId: msg.ticketId,
          sessionId: session.id,
          status: "plan_ready",
          branchName: branchName ?? undefined,
        });
      };
      session.once("exit", onExit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: handleStartPlanning error: ${message}`);
    }
  }

  private async handleStartInteractivePlanning(msg: RelayStartInteractivePlanningMsg): Promise<void> {
    const resolvedCwd = this.resolveCwd(msg.cwd);

    // --- Worktree resolution ---
    let effectiveCwd = resolvedCwd;
    let worktreePath: string | null = null;
    let branchName: string | null = null;

    if (msg.useWorktree) {
      const existingWt = ticketTracker.getWorktreeInfo(msg.ticketId);
      if (existingWt?.worktreePath) {
        effectiveCwd = existingWt.worktreePath;
        worktreePath = existingWt.worktreePath;
        branchName = existingWt.branchName;
      } else {
        const wt = await createWorktree(resolvedCwd, msg.ticketId);
        if (wt) {
          effectiveCwd = wt.worktreePath;
          worktreePath = wt.worktreePath;
          branchName = wt.branchName;
        }
      }
    }

    const orgSettings = getAnyOrgSettings();
    const orgInstructions = orgSettings?.settings.systemInstructions?.map((i) => i.content) ?? [];
    const allInstructions = [...new Set([...orgInstructions, ...msg.systemInstructions])];

    const planningPrompt = [
      "You are planning the implementation of a ticket.",
      "",
      `Title: ${msg.ticketTitle}`,
      `Description: ${msg.ticketDescription}`,
      "",
      ...allInstructions.map((i) => `System Instruction:\n${i}`),
      "",
      "Please analyze the requirements and create a detailed implementation plan. Include:",
      "- Files to create/modify",
      "- Key implementation steps",
      "- Any potential issues or considerations",
    ].join("\n");

    const driverName = msg.driverName || DEFAULT_DRIVER_NAME;
    debugLog(`relay: start interactive planning ticket=${msg.ticketId} cwd=${effectiveCwd} driver=${driverName}${branchName ? ` branch=${branchName}` : ""}`);

    try {
      const session = appStore.getState().createSession(driverName, effectiveCwd);
      if (!session) {
        debugLog("relay: failed to create interactive planning session");
        return;
      }

      ticketTracker.startPlanning(msg.ticketId, session.id, msg.ticketTitle, resolvedCwd, worktreePath, branchName);

      this.send({
        type: "cli_ticket_status",
        ticketId: msg.ticketId,
        sessionId: session.id,
        status: "planning",
        branchName: branchName ?? undefined,
      });

      session.start({ prompt: planningPrompt, model: msg.model }).catch((err) => debugLog(`relay: interactive planning start failed: ${err}`));

      // Set session metadata so clients know this is interactive
      appStore.getState().setSessionMeta(session.id, {
        interactive: true,
        command: `${driverName} "<planning prompt>"`,
      });
      this.registerSession(session.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: handleStartInteractivePlanning error: ${message}`);
    }
  }

  private async handleStartImplementation(msg: RelayStartImplementationMsg): Promise<void> {
    const resolvedCwd = this.resolveCwd(msg.cwd);

    // --- Worktree resolution ---
    let effectiveCwd = resolvedCwd;
    let worktreePath: string | null = null;
    let branchName: string | null = null;

    // Reuse worktree from planning phase if one exists
    const existingWt = ticketTracker.getWorktreeInfo(msg.ticketId);
    if (existingWt?.worktreePath) {
      effectiveCwd = existingWt.worktreePath;
      worktreePath = existingWt.worktreePath;
      branchName = existingWt.branchName;
    } else if (msg.useWorktree) {
      const wt = await createWorktree(resolvedCwd, msg.ticketId);
      if (wt) {
        effectiveCwd = wt.worktreePath;
        worktreePath = wt.worktreePath;
        branchName = wt.branchName;
      }
    }

    const orgSettings = getAnyOrgSettings();
    const orgInstructions = orgSettings?.settings.systemInstructions?.map((i) => i.content) ?? [];
    const allInstructions = [...new Set([...orgInstructions, ...msg.systemInstructions])];

    const promptParts = [
      "You are implementing a plan. Follow the plan exactly.",
      "",
      "Plan:",
      msg.plan,
      "",
      ...allInstructions.map((i) => `System Instruction:\n${i}`),
    ];

    if (branchName) {
      promptParts.push(
        "",
        `You are working on a dedicated git worktree branch: ${branchName}`,
        "All your changes are already isolated on this branch. Commit your changes when done.",
      );
    } else {
      promptParts.push(
        "",
        "Implement the plan step by step. When done, create a git branch and commit your changes.",
      );
    }

    const implementPrompt = promptParts.join("\n");

    const driverName = msg.driverName || DEFAULT_DRIVER_NAME;
    debugLog(`relay: start implementation ticket=${msg.ticketId} cwd=${effectiveCwd} driver=${driverName}${branchName ? ` branch=${branchName}` : ""}`);

    try {
      const session = appStore.getState().createSession(driverName, effectiveCwd);
      if (!session) {
        debugLog("relay: failed to create implementation session");
        return;
      }

      ticketTracker.startImplementation(msg.ticketId, session.id);

      // Update worktree info if we created/found one during implementation
      const wtInfo = ticketTracker.getWorktreeInfo(msg.ticketId);
      if (wtInfo && (!wtInfo.worktreePath && worktreePath)) {
        // Patch the tracker entry with worktree info discovered in this step
        const entry = ticketTracker.getAll().get(msg.ticketId);
        if (entry) {
          entry.originalCwd = resolvedCwd;
          entry.worktreePath = worktreePath;
          entry.branchName = branchName;
        }
      }

      this.send({
        type: "cli_ticket_status",
        ticketId: msg.ticketId,
        sessionId: session.id,
        status: "implementing",
        branchName: branchName ?? undefined,
      });

      session.start({ prompt: implementPrompt, model: msg.model }).catch((err) => debugLog(`relay: implementation start failed: ${err}`));

      // Set session metadata so clients know this is interactive
      appStore.getState().setSessionMeta(session.id, {
        interactive: true,
        command: `${driverName} "<implementation prompt>"`,
      });
      this.registerSession(session.id);

      // Monitor session status for implementation completion
      const onStatus = (status: string) => {
        if (status === "waiting_input" || status === "exited") {
          session.removeListener("status", onStatus);

          const plainText = session.getPlainText(500).join("\n");

          ticketTracker.updateStatus(msg.ticketId, "done");

          this.send({
            type: "cli_implementation_done",
            ticketId: msg.ticketId,
            sessionId: session.id,
            summary: plainText,
            gitContext: { branch: branchName ?? undefined },
          });

          this.send({
            type: "cli_ticket_status",
            ticketId: msg.ticketId,
            sessionId: session.id,
            status: "done",
            branchName: branchName ?? undefined,
          });
        }
      };
      session.on("status", onStatus);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: handleStartImplementation error: ${message}`);
    }
  }

  private handleRequestChanges(msg: RelayRequestChangesMsg): void {
    debugLog(`relay: request changes ticket=${msg.ticketId} session=${msg.sessionId}`);

    const sessionId = ticketTracker.getSessionForTicket(msg.ticketId);
    if (!sessionId) {
      debugLog(`relay: no tracked session for ticket ${msg.ticketId}`);
      return;
    }

    const session = getSessionInstance(sessionId);
    if (!session) {
      debugLog(`relay: session instance ${sessionId} not found for changes request`);
      return;
    }

    session.write(msg.feedback + "\n");
  }

  // -------------------------------------------------------------------------
  // E2E key exchange handlers
  // -------------------------------------------------------------------------

  private async handleViewerPublicKey(
    sessionId: string,
    viewerId: string,
    peerPubKeyBase64: string,
  ): Promise<void> {
    const tracked = this.trackedSessions.get(sessionId);
    if (!tracked?.keyPair || !tracked.sck) {
      debugLog(`relay: viewer key for ${sessionId} but no E2E state`);
      return;
    }

    try {
      setSessionEncryptionStatus(sessionId, "key-exchange");

      const peerPubKey = await importPeerPublicKey(peerPubKeyBase64);
      const { kek, salt } = await deriveKeyEncryptionKey(
        tracked.keyPair.privateKey,
        peerPubKey,
        tracked.keyPair.publicKeyBase64,
        peerPubKeyBase64,
      );

      // Wrap SCK for this viewer
      const wrappedKey = await wrapSessionContentKey(tracked.sck, kek);

      tracked.viewerKeys.set(viewerId, { kek, keyDelivered: true });

      // Send wrapped SCK + salt to viewer (via relay)
      this.send({
        type: "cli_wrapped_key",
        sessionId,
        viewerId,
        wrappedKey,
        salt,
      });

      debugLog(`relay: delivered wrapped SCK to viewer ${viewerId} for ${sessionId}`);
      setSessionEncryptionStatus(sessionId, "active");

      // Send replay buffer encrypted for the new viewer
      await this.sendEncryptedReplay(tracked);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: key exchange failed for viewer ${viewerId}: ${message}`);
    }
  }

  private async handleEncryptedInput(
    sessionId: string,
    viewerId: string,
    encryptedData: string,
  ): Promise<void> {
    const shareMode = settingsStore.getState().config.relay.defaultShareMode;
    if (shareMode === "read-only") {
      debugLog(`relay: ignoring encrypted input for ${sessionId} (read-only mode)`);
      return;
    }

    if (!this.inputLimiter.allow(viewerId)) {
      debugLog(`relay: rate limited encrypted input from ${viewerId}`);
      return;
    }

    const tracked = this.trackedSessions.get(sessionId);
    if (!tracked?.sck) {
      debugLog(`relay: encrypted input for ${sessionId} but no SCK`);
      return;
    }

    const session = getSessionInstance(sessionId);
    if (!session) return;

    try {
      const plaintext = await decryptData(encryptedData, tracked.sck);
      session.scrollToBottom();
      session.write(plaintext.toString("utf-8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`relay: failed to decrypt input from ${viewerId}: ${message}`);
      // Silently drop — never crash
    }
  }

  private cleanupViewerCrypto(sessionId: string, viewerId: string): void {
    const tracked = this.trackedSessions.get(sessionId);
    if (tracked) {
      tracked.viewerKeys.delete(viewerId);
    }
  }

  // -------------------------------------------------------------------------
  // Encrypted PTY data sending
  // -------------------------------------------------------------------------

  private async sendPtyData(tracked: TrackedSession, rawData: string): Promise<void> {
    if (tracked.sck) {
      // E2E enabled — encrypt with SCK
      try {
        const plaintext = Buffer.from(rawData, "utf-8");
        const encrypted = await encryptData(plaintext, tracked.sck);
        const seq = tracked.encryptSeq++;
        this.send({
          type: "cli_encrypted_pty_data",
          sessionId: tracked.sessionId,
          data: encrypted,
          seq,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog(`relay: encrypt PTY data failed: ${message}`);
      }
    } else if (this.e2eEnabled) {
      // E2E is enabled but no SCK — key generation must have failed.
      // Do NOT send plaintext — drop the data and flag the failure.
      debugLog(`relay: dropping PTY data for ${tracked.sessionId} — E2E enabled but no SCK`);
      setSessionEncryptionStatus(tracked.sessionId, "failed");
    } else {
      // Plaintext is intentionally allowed (e2eEncryption: false in config)
      const base64 = Buffer.from(rawData, "utf-8").toString("base64");
      this.send({
        type: "cli_pty_data",
        sessionId: tracked.sessionId,
        data: base64,
      });
    }
  }

  private async sendEncryptedReplay(tracked: TrackedSession): Promise<void> {
    if (!tracked.sck) return;

    const chunks = this.replayBuffer.get(tracked.sessionId);
    for (const chunk of chunks) {
      try {
        const plaintext = Buffer.from(chunk, "utf-8");
        const encrypted = await encryptData(plaintext, tracked.sck);
        const seq = tracked.encryptSeq++;
        this.send({
          type: "cli_encrypted_pty_data",
          sessionId: tracked.sessionId,
          data: encrypted,
          seq,
        });
      } catch {
        debugLog("relay: failed to encrypt replay chunk");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Session tracking — watch appStore for session add/remove
  // -------------------------------------------------------------------------

  private async watchSessions(): Promise<void> {
    let prevIds = new Set(appStore.getState().sessions.map((s) => s.id));

    // Track existing sessions
    for (const s of appStore.getState().sessions) {
      await this.trackSession(s.id);
    }

    this.storeUnsub = appStore.subscribe((state) => {
      const currentIds = new Set(state.sessions.map((s) => s.id));

      // New sessions
      for (const id of currentIds) {
        if (!prevIds.has(id)) {
          // Register immediately so the session appears in the browser right away
          this.registerSession(id);
          // Then track async for E2E crypto and PTY data streaming
          this.trackSession(id).then(() => {
            // Re-register with public key once E2E keys are generated
            const tracked = this.trackedSessions.get(id);
            if (tracked?.keyPair) {
              this.registerSession(id);
            }
          });
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
          setSessionEncryptionStatus(id, "none");
          this.send({ type: "cli_unregister_session", sessionId: id });
        }
      }

      prevIds = currentIds;
    });
  }

  private async trackSession(sessionId: string): Promise<void> {
    if (this.trackedSessions.has(sessionId)) return;

    const session = getSessionInstance(sessionId);
    if (!session) return;

    // Generate crypto state if E2E enabled
    let keyPair: SessionKeyPair | null = null;
    let sck: SessionContentKey | null = null;

    if (this.e2eEnabled) {
      try {
        keyPair = await generateSessionKeyPair();
        sck = await generateSessionContentKey();
        debugLog(`relay: generated E2E keys for session ${sessionId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog(`relay: CRITICAL: E2E key generation failed: ${message}`);
        setSessionEncryptionStatus(sessionId, "failed");
        return; // Abort — do not stream data without E2E
      }
    }

    const tracked: TrackedSession = {
      sessionId,
      rawDataUnsub: null,
      statusUnsub: null,
      keyPair,
      sck,
      viewerKeys: new Map(),
      encryptSeq: 0,
    };

    // Stream raw PTY data to relay
    tracked.rawDataUnsub = session.onRawData((data: string) => {
      this.replayBuffer.push(sessionId, data);
      this.sendPtyData(tracked, data);
    });

    // Forward status changes (with detailed fields when available)
    const onStatus = (status: string) => {
      const detailed = session.detailedStatus;
      const msg: import("./relay-protocol.js").CliSessionStatusMsg = {
        type: "cli_session_status",
        sessionId,
        status,
      };
      if (detailed && "detail" in detailed) {
        msg.detailedState = detailed.state;
        msg.detailedDetail = (detailed as { detail: string }).detail;
      } else if (detailed) {
        msg.detailedState = detailed.state;
      }
      if (session.currentTool) {
        msg.currentTool = session.currentTool;
      }
      this.send(msg);
    };
    session.on("status", onStatus);

    // Forward metadata changes (throttled — every 10s max)
    let lastMetadataSend = 0;
    let metadataTimer: ReturnType<typeof setTimeout> | null = null;
    const sendMetadata = () => {
      const data = sessionMetadataStore.get(sessionId);
      if (!data) return;
      this.send({
        type: "cli_session_metadata" as const,
        sessionId,
        modelId: data.modelId,
        modelDisplayName: data.modelDisplayName,
        totalCostUsd: data.totalCostUsd,
        totalDurationMs: data.totalDurationMs,
        totalLinesAdded: data.totalLinesAdded,
        totalLinesRemoved: data.totalLinesRemoved,
        usedPercentage: data.contextWindow?.usedPercentage,
        contextTotalTokens: data.contextWindow?.totalTokens,
        contextUsedTokens: data.contextWindow?.usedTokens,
        showCost: settingsStore.getState().config.ui.showCost,
      });
      lastMetadataSend = Date.now();
    };
    const onMetadata = () => {
      const now = Date.now();
      if (now - lastMetadataSend >= 10_000) {
        sendMetadata();
      } else if (!metadataTimer) {
        metadataTimer = setTimeout(() => {
          metadataTimer = null;
          sendMetadata();
        }, 10_000 - (now - lastMetadataSend));
      }
    };
    session.on("metadata", onMetadata);

    tracked.statusUnsub = () => {
      session.removeListener("status", onStatus);
      session.removeListener("metadata", onMetadata);
      if (metadataTimer) {
        clearTimeout(metadataTimer);
        metadataTimer = null;
      }
    };

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
    // Zero out raw key material before clearing references
    if (tracked.sck?.rawBytes) {
      tracked.sck.rawBytes.fill(0);
    }
    tracked.keyPair = null;
    tracked.sck = null;
    tracked.viewerKeys.clear();
    setSessionEncryptionStatus(tracked.sessionId, "none");
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

    const tracked = this.trackedSessions.get(sessionId);

    this.send({
      type: "cli_register_session",
      sessionId,
      driverName: sessionState.driverName,
      displayName: sessionState.displayName,
      cwd: sessionState.cwd,
      status: sessionState.status,
      cols: instance.cols,
      rows: instance.rows,
      publicKey: tracked?.keyPair?.publicKeyBase64,
      interactive: sessionState.interactive,
      command: sessionState.command,
    });

    // Send metadata if available (e.g. on reconnect)
    const meta = sessionMetadataStore.get(sessionId);
    if (meta) {
      this.send({
        type: "cli_session_metadata",
        sessionId,
        modelId: meta.modelId,
        modelDisplayName: meta.modelDisplayName,
        totalCostUsd: meta.totalCostUsd,
        totalDurationMs: meta.totalDurationMs,
        totalLinesAdded: meta.totalLinesAdded,
        totalLinesRemoved: meta.totalLinesRemoved,
        usedPercentage: meta.contextWindow?.usedPercentage,
        contextTotalTokens: meta.contextWindow?.totalTokens,
        contextUsedTokens: meta.contextWindow?.usedTokens,
      });
    }
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

  public sendUserSettings(worktreeDefaults: Partial<{ planning: boolean; interactivePlanning: boolean; implementation: boolean }>): void {
    this.send({
      type: "cli_set_user_settings",
      worktreeDefaults,
    });
  }

  private send(msg: CliToRelayMsg): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return;

    // Backpressure: drop PTY data if buffer is backing up
    if (
      (msg.type === "cli_pty_data" || msg.type === "cli_encrypted_pty_data") &&
      this.ws.bufferedAmount > 256 * 1024
    ) {
      return;
    }

    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      debugLog("relay: send error");
    }
  }
}
