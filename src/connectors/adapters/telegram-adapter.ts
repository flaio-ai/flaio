import type {
  IConnector,
  ConnectorStatus,
  PermissionRequest,
  PermissionReply,
  ToolResult,
  SessionNotification,
} from "../connector-interface.js";

export interface TelegramConfig {
  botToken: string;
  chatId: string | number;
  timeout?: number;
}

export class TelegramAdapter implements IConnector {
  readonly name = "telegram";
  readonly displayName = "Telegram";
  private _status: ConnectorStatus = "disconnected";
  private promptHandler: ((prompt: string, sessionId?: string) => void) | null = null;
  private bot: any = null;
  private pendingPermissions: Map<
    string,
    { resolve: (reply: PermissionReply) => void; timer: ReturnType<typeof setTimeout> }
  > = new Map();

  constructor(private config: TelegramConfig) {}

  get status(): ConnectorStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    this._status = "connecting";

    try {
      // @ts-ignore — optional dependency, installed when Telegram connector is enabled
      const telegrafModule: any = await import("telegraf");
      const Telegraf = telegrafModule.Telegraf ?? telegrafModule.default;
      this.bot = new Telegraf(this.config.botToken);

      // Handle callback queries (inline keyboard button presses)
      this.bot.on("callback_query", (ctx: any) => {
        const data = ctx.callbackQuery?.data;
        if (!data) return;

        const [action, requestId] = data.split(":");
        if (!requestId) return;

        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingPermissions.delete(requestId);

        ctx.answerCbQuery(action === "allow" ? "Allowed" : "Denied");

        pending.resolve({
          allowed: action === "allow",
          message: action === "allow" ? undefined : "Denied by user",
        });
      });

      // Handle text messages for prompts
      this.bot.on("text", (ctx: any) => {
        if (String(ctx.chat?.id) !== String(this.config.chatId)) return;
        if (this.promptHandler) {
          this.promptHandler(ctx.message.text.trim());
        }
      });

      await this.bot.launch();
      this._status = "connected";
    } catch (err) {
      this._status = "error";
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        // Best effort
      }
    }
    // Clean up pending permissions
    for (const [, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ allowed: false, message: "Disconnected" });
    }
    this.pendingPermissions.clear();
    this.bot = null;
    this._status = "disconnected";
  }

  async requestPermission(request: PermissionRequest): Promise<PermissionReply> {
    if (!this.bot) {
      return { allowed: false, message: "Telegram not connected" };
    }

    const inputStr = JSON.stringify(request.toolInput, null, 2);
    const truncated = inputStr.length > 2000 ? inputStr.slice(0, 2000) + "\n..." : inputStr;
    const project = request.cwd.split("/").filter(Boolean).pop() ?? "unknown";
    const requestId = `${request.sessionId}-${Date.now()}`;

    const text = [
      `*Agent needs permission*`,
      `*Project:* \`${project}\` (\`${request.cwd}\`)`,
      `*Session:* \`${request.sessionId}\``,
      `*Tool:* \`${request.toolName}\``,
      "",
      `\`\`\``,
      truncated,
      `\`\`\``,
    ].join("\n");

    try {
      await this.bot.telegram.sendMessage(this.config.chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Allow", callback_data: `allow:${requestId}` },
              { text: "Deny", callback_data: `deny:${requestId}` },
            ],
          ],
        },
      });

      return await this.waitForCallbackReply(requestId);
    } catch {
      return { allowed: false, message: "Telegram API error" };
    }
  }

  async postToolResult(result: ToolResult): Promise<void> {
    if (!this.bot) return;

    const truncOutput = result.output.length > 2000
      ? "..." + result.output.slice(-2000)
      : result.output;

    const text = [
      `*Tool completed:* \`${result.toolName}\``,
      `\`\`\``,
      truncOutput || "(empty)",
      `\`\`\``,
    ].join("\n");

    try {
      await this.bot.telegram.sendMessage(this.config.chatId, text, {
        parse_mode: "Markdown",
      });
    } catch {
      // Non-critical
    }
  }

  async postNotification(notification: SessionNotification): Promise<void> {
    if (!this.bot) return;

    const text = [
      `*${notification.type}* — Session \`${notification.sessionId}\``,
      notification.message,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await this.bot.telegram.sendMessage(this.config.chatId, text, {
        parse_mode: "Markdown",
      });
    } catch {
      // Non-critical
    }
  }

  onPrompt(handler: (prompt: string, sessionId?: string) => void): void {
    this.promptHandler = handler;
  }

  private waitForCallbackReply(requestId: string): Promise<PermissionReply> {
    const timeout = this.config.timeout ?? 300000;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve({ allowed: false, message: "Timed out" });
      }, timeout);

      this.pendingPermissions.set(requestId, { resolve, timer });
    });
  }
}
