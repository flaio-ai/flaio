import type {
  IConnector,
  ConnectorStatus,
  PermissionRequest,
  PermissionReply,
  ToolResult,
  SessionNotification,
} from "../connector-interface.js";

const ALLOW_WORDS = ["allow", "yes", "y", "approve", "ok", "accept"];
const DENY_WORDS = ["deny", "no", "n", "reject", "block"];

export interface SlackConfig {
  botToken: string;
  appToken?: string; // For Socket Mode (xapp- token)
  channelId: string;
  pollInterval?: number;
  timeout?: number;
}

export class SlackAdapter implements IConnector {
  readonly name = "slack";
  readonly displayName = "Slack";
  private _status: ConnectorStatus = "disconnected";
  private promptHandler: ((prompt: string, sessionId?: string) => void) | null = null;
  private webClient: any = null;
  private socketClient: any = null;

  // Per-session threading
  private sessionThreads: Map<string, string> = new Map(); // sessionId → thread root ts
  private threadToSession: Map<string, string> = new Map(); // thread root ts → sessionId
  private botUserId: string | null = null;

  // Thread polling for inbound prompts (reliable fallback for Socket Mode)
  private threadLastSeen: Map<string, string> = new Map(); // threadRootTs → last processed msg ts
  private threadPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: SlackConfig) {}

  get status(): ConnectorStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    this._status = "connecting";

    try {
      // @ts-ignore — optional dependency, installed when Slack connector is enabled
      const webApiModule: any = await import("@slack/web-api");
      this.webClient = new webApiModule.WebClient(this.config.botToken);

      // Resolve bot user ID for filtering own messages
      try {
        const authResult = await this.webClient.auth.test();
        this.botUserId = authResult.user_id ?? null;
      } catch {
        // Non-fatal — bot filtering will rely on bot_id/subtype only
        this.botUserId = null;
      }

      // Try Socket Mode if appToken is provided
      if (this.config.appToken) {
        try {
          // @ts-ignore — optional dependency
          const socketModule: any = await import("@slack/socket-mode");
          this.socketClient = new socketModule.SocketModeClient({
            appToken: this.config.appToken,
          });

          this.socketClient.on("message", (event: any) => {
            // Acknowledge the envelope so Slack doesn't retry/drop events
            if (typeof event?.ack === "function") {
              Promise.resolve(event.ack()).catch(() => {});
            }
            this.handleSocketMessage(event);
          });

          await this.socketClient.start();
        } catch {
          // Socket Mode optional — fall back to polling
          this.socketClient = null;
        }
      }

      this._status = "connected";
      this.startThreadPolling();
    } catch (err) {
      this._status = "error";
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.stopThreadPolling();

    if (this.socketClient) {
      try {
        await this.socketClient.disconnect();
      } catch {
        // Best effort
      }
    }
    this.webClient = null;
    this.socketClient = null;
    this.sessionThreads.clear();
    this.threadToSession.clear();
    this.threadLastSeen.clear();
    this.botUserId = null;
    this._status = "disconnected";
  }

  async requestPermission(request: PermissionRequest): Promise<PermissionReply> {
    if (!this.webClient) {
      return { allowed: false, message: "Slack not connected" };
    }

    const threadTs = await this.ensureSessionThread(request.sessionId, request.cwd);

    const inputStr = JSON.stringify(request.toolInput, null, 2);
    const truncated = inputStr.length > 2500 ? inputStr.slice(0, 2500) + "\n..." : inputStr;

    const text = [
      `*Agent needs permission*`,
      `*Tool:* \`${request.toolName}\``,
      "",
      "```",
      truncated,
      "```",
      "",
      `Reply in this thread: *allow* or *deny*`,
    ].join("\n");

    try {
      const result = await this.webClient.chat.postMessage({
        channel: this.config.channelId,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
      });

      // Poll for reply in the session thread, only considering messages after the permission question
      const afterTs = result.ts;
      const reply = await this.pollForReply(threadTs, afterTs);

      await this.webClient.chat.postMessage({
        channel: this.config.channelId,
        thread_ts: threadTs,
        text: reply.allowed ? "*Allowed*" : `*Denied*${reply.message ? `: ${reply.message}` : ""}`,
        unfurl_links: false,
      });

      return reply;
    } catch {
      return { allowed: false, message: "Slack API error" };
    }
  }

  async postToolResult(result: ToolResult): Promise<void> {
    if (!this.webClient) return;

    const threadTs = await this.ensureSessionThread(result.sessionId);

    const inputStr = JSON.stringify(result.input, null, 2);
    const truncInput = inputStr.length > 500 ? inputStr.slice(0, 500) + "..." : inputStr;
    const truncOutput = result.output.length > 2500 ? "..." + result.output.slice(-2500) : result.output;

    const text = [
      `*Tool completed:* \`${result.toolName}\``,
      "",
      `*Input:*`,
      "```",
      truncInput,
      "```",
      `*Result:*`,
      "```",
      truncOutput || "(empty)",
      "```",
    ].join("\n");

    try {
      await this.webClient.chat.postMessage({
        channel: this.config.channelId,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
      });
    } catch {
      // Non-critical
    }
  }

  async postNotification(notification: SessionNotification): Promise<void> {
    if (!this.webClient) return;

    if (notification.type === "started") {
      // "started" is the thread root — ensureSessionThread creates the top-level message
      await this.ensureSessionThread(notification.sessionId, notification.cwd);
      return;
    }

    const threadTs = await this.ensureSessionThread(notification.sessionId, notification.cwd);

    // Agent response — post the message text directly, no label prefix
    if (notification.type === "response") {
      const truncated =
        notification.message.length > 3000
          ? notification.message.slice(0, 3000) + "\n..."
          : notification.message;

      try {
        await this.webClient.chat.postMessage({
          channel: this.config.channelId,
          thread_ts: threadTs,
          text: truncated,
          unfurl_links: false,
        });
      } catch {
        // Non-critical
      }
      return;
    }

    const typeLabels: Record<string, string> = {
      stopped: "Session ended",
      waiting_input: "Waiting for input",
      error: "Error",
    };

    const text = [
      `*${typeLabels[notification.type] ?? notification.type}*`,
      notification.message,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await this.webClient.chat.postMessage({
        channel: this.config.channelId,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
      });
    } catch {
      // Non-critical
    }

    // Clean up maps when session ends
    if (notification.type === "stopped") {
      this.sessionThreads.delete(notification.sessionId);
      this.threadToSession.delete(threadTs);
      this.threadLastSeen.delete(threadTs);
    }
  }

  onPrompt(handler: (prompt: string, sessionId?: string) => void): void {
    this.promptHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Thread management
  // ---------------------------------------------------------------------------

  /**
   * Ensure a Slack thread exists for the given session.
   * Posts a top-level "Session started" message if one doesn't exist yet.
   * Idempotent — safe to call from any method.
   */
  private async ensureSessionThread(sessionId: string, cwd?: string): Promise<string> {
    const existing = this.sessionThreads.get(sessionId);
    if (existing) return existing;

    const project = cwd?.split("/").filter(Boolean).pop() ?? "unknown";

    const text = [
      `*Session started*`,
      `*Project:* \`${project}\``,
      cwd ? `*CWD:* \`${cwd}\`` : null,
      `*Session:* \`${sessionId}\``,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const result = await this.webClient.chat.postMessage({
        channel: this.config.channelId,
        text,
        unfurl_links: false,
      });

      const ts = result.ts as string;
      this.sessionThreads.set(sessionId, ts);
      this.threadToSession.set(ts, sessionId);
      // Initialize lastSeen to thread root ts so we don't replay old messages
      this.threadLastSeen.set(ts, ts);
      return ts;
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // Socket Mode — low-latency path (when Slack app has event subscriptions)
  // ---------------------------------------------------------------------------

  private handleSocketMessage(event: any): void {
    if (!this.promptHandler) return;

    const msg = event?.event ?? event;
    const text = (msg?.text ?? "").trim();
    if (!text) return;

    // Filter: own bot messages
    if (this.botUserId && msg.user === this.botUserId) return;
    if (msg.bot_id || msg.subtype === "bot_message") return;

    // Filter: wrong channel
    if (msg.channel && msg.channel !== this.config.channelId) return;

    // Filter: allow/deny keywords — those are handled by permission polling, not prompts
    const lower = text.toLowerCase();
    if (ALLOW_WORDS.includes(lower) || DENY_WORDS.includes(lower)) return;

    // Track this message so the thread poll doesn't re-deliver it
    const threadRootTs = msg.thread_ts;
    if (threadRootTs && msg.ts) {
      const prev = this.threadLastSeen.get(threadRootTs);
      if (!prev || msg.ts > prev) {
        this.threadLastSeen.set(threadRootTs, msg.ts);
      }
    }

    // Thread routing: look up which session this thread belongs to
    if (threadRootTs) {
      const sessionId = this.threadToSession.get(threadRootTs);
      this.promptHandler(text, sessionId);
    } else {
      // Top-level message — routes to active session (no sessionId)
      this.promptHandler(text);
    }
  }

  // ---------------------------------------------------------------------------
  // Thread polling — reliable path for inbound prompts via API
  // ---------------------------------------------------------------------------

  private startThreadPolling(): void {
    const interval = this.config.pollInterval ?? 3000;
    this.threadPollTimer = setInterval(() => {
      this.pollSessionThreads().catch(() => {});
    }, interval);
  }

  private stopThreadPolling(): void {
    if (this.threadPollTimer) {
      clearInterval(this.threadPollTimer);
      this.threadPollTimer = null;
    }
  }

  /**
   * Poll all active session threads for new user messages and route as prompts.
   */
  private async pollSessionThreads(): Promise<void> {
    if (!this.webClient || !this.promptHandler) return;

    for (const [sessionId, threadTs] of this.sessionThreads) {
      if (!threadTs) continue;
      const lastSeen = this.threadLastSeen.get(threadTs) ?? threadTs;

      try {
        const result = await this.webClient.conversations.replies({
          channel: this.config.channelId,
          ts: threadTs,
          limit: 20,
        });

        if (!result.messages) continue;

        let maxTs = lastSeen;
        for (const msg of result.messages) {
          // Skip already-seen messages
          if (msg.ts <= lastSeen) continue;
          // Track highest ts regardless of message type
          if (msg.ts > maxTs) maxTs = msg.ts;

          // Skip bot messages
          if (msg.bot_id || msg.subtype === "bot_message") continue;
          if (this.botUserId && msg.user === this.botUserId) continue;

          const text = (msg.text ?? "").trim();
          if (!text) continue;

          // Skip allow/deny keywords — those are for permission polling
          const lower = text.toLowerCase();
          if (ALLOW_WORDS.includes(lower) || DENY_WORDS.includes(lower)) continue;

          // Route as prompt to the correct session
          this.promptHandler(text, sessionId);
        }

        // Advance high-water mark
        if (maxTs > lastSeen) {
          this.threadLastSeen.set(threadTs, maxTs);
        }
      } catch {
        // Poll error — continue to next thread
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Permission reply polling
  // ---------------------------------------------------------------------------

  private async pollForReply(threadRootTs: string, afterTs: string): Promise<PermissionReply> {
    const timeout = this.config.timeout ?? 300000;
    const interval = this.config.pollInterval ?? 2000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        const result = await this.webClient.conversations.replies({
          channel: this.config.channelId,
          ts: threadRootTs,
          limit: 50,
        });

        if (result.messages) {
          for (const msg of result.messages) {
            // Skip messages at or before the permission question
            if (msg.ts <= afterTs) continue;
            // Skip bot messages
            if (msg.bot_id || msg.subtype === "bot_message") continue;
            if (this.botUserId && msg.user === this.botUserId) continue;

            const msgText = (msg.text ?? "").trim().toLowerCase();
            if (ALLOW_WORDS.includes(msgText)) return { allowed: true };
            if (DENY_WORDS.includes(msgText)) return { allowed: false, message: "Denied by user" };
          }
        }
      } catch {
        // Poll error — continue
      }

      await new Promise((r) => setTimeout(r, interval));
    }

    return { allowed: false, message: "Timed out" };
  }
}
