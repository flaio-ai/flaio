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

      // Try Socket Mode if appToken is provided
      if (this.config.appToken) {
        try {
          // @ts-ignore — optional dependency
          const socketModule: any = await import("@slack/socket-mode");
          this.socketClient = new socketModule.SocketModeClient({
            appToken: this.config.appToken,
          });

          this.socketClient.on("message", (event: any) => {
            this.handleSocketMessage(event);
          });

          await this.socketClient.start();
        } catch {
          // Socket Mode optional — fall back to polling
          this.socketClient = null;
        }
      }

      this._status = "connected";
    } catch (err) {
      this._status = "error";
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.socketClient) {
      try {
        await this.socketClient.disconnect();
      } catch {
        // Best effort
      }
    }
    this.webClient = null;
    this.socketClient = null;
    this._status = "disconnected";
  }

  async requestPermission(request: PermissionRequest): Promise<PermissionReply> {
    if (!this.webClient) {
      return { allowed: false, message: "Slack not connected" };
    }

    const inputStr = JSON.stringify(request.toolInput, null, 2);
    const truncated = inputStr.length > 2500 ? inputStr.slice(0, 2500) + "\n..." : inputStr;
    const project = request.cwd.split("/").filter(Boolean).pop() ?? "unknown";

    const text = [
      `*Agent needs permission*`,
      `*Project:* \`${project}\` (\`${request.cwd}\`)`,
      `*Session:* \`${request.sessionId}\``,
      `*Tool:* \`${request.toolName}\``,
      "",
      "```",
      truncated,
      "```",
      "",
      `Reply in thread: *allow* or *deny*`,
    ].join("\n");

    try {
      const result = await this.webClient.chat.postMessage({
        channel: this.config.channelId,
        text,
        unfurl_links: false,
      });

      const messageTs = result.ts;
      const reply = await this.pollForReply(messageTs);

      await this.webClient.chat.postMessage({
        channel: this.config.channelId,
        thread_ts: messageTs,
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
        text,
        unfurl_links: false,
      });
    } catch {
      // Non-critical
    }
  }

  async postNotification(notification: SessionNotification): Promise<void> {
    if (!this.webClient) return;

    const typeLabels: Record<string, string> = {
      started: "Session started",
      stopped: "Session ended",
      waiting_input: "Waiting for input",
      error: "Error",
    };

    const text = [
      `*${typeLabels[notification.type] ?? notification.type}*`,
      `*Session:* \`${notification.sessionId}\``,
      notification.cwd ? `*CWD:* \`${notification.cwd}\`` : null,
      notification.message,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await this.webClient.chat.postMessage({
        channel: this.config.channelId,
        text,
        unfurl_links: false,
      });
    } catch {
      // Non-critical
    }
  }

  onPrompt(handler: (prompt: string, sessionId?: string) => void): void {
    this.promptHandler = handler;
  }

  private handleSocketMessage(event: any): void {
    if (!this.promptHandler) return;
    const text = event?.event?.text?.trim();
    if (!text) return;
    this.promptHandler(text);
  }

  private async pollForReply(messageTs: string): Promise<PermissionReply> {
    const timeout = this.config.timeout ?? 300000;
    const interval = this.config.pollInterval ?? 2000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        const result = await this.webClient.conversations.replies({
          channel: this.config.channelId,
          ts: messageTs,
          limit: 10,
        });

        if (result.messages && result.messages.length > 1) {
          for (const msg of result.messages.slice(1)) {
            if (msg.bot_id || msg.subtype === "bot_message") continue;
            const text = (msg.text ?? "").trim().toLowerCase();
            if (ALLOW_WORDS.includes(text)) return { allowed: true };
            if (DENY_WORDS.includes(text)) return { allowed: false, message: "Denied by user" };
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
