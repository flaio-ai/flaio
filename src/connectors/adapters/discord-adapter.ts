import type {
  IConnector,
  ConnectorStatus,
  PermissionRequest,
  PermissionReply,
  ToolResult,
  SessionNotification,
} from "../connector-interface.js";

export interface DiscordConfig {
  botToken: string;
  channelId: string;
  timeout?: number;
}

export class DiscordAdapter implements IConnector {
  readonly name = "discord";
  readonly displayName = "Discord";
  private _status: ConnectorStatus = "disconnected";
  private promptHandler: ((prompt: string, sessionId?: string) => void) | null = null;
  private client: any = null;
  private channel: any = null;

  constructor(private config: DiscordConfig) {}

  get status(): ConnectorStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    this._status = "connecting";

    try {
      // @ts-ignore — optional dependency, installed when Discord connector is enabled
      const discord: any = await import("discord.js");
      this.client = new discord.Client({
        intents: [
          discord.GatewayIntentBits.Guilds,
          discord.GatewayIntentBits.GuildMessages,
          discord.GatewayIntentBits.MessageContent,
        ],
      });

      await this.client.login(this.config.botToken);

      this.channel = await this.client.channels.fetch(this.config.channelId);

      // Listen for messages for prompt forwarding
      this.client.on("messageCreate", (msg: any) => {
        if (msg.author.bot) return;
        if (msg.channel.id !== this.config.channelId) return;
        if (this.promptHandler) {
          this.promptHandler(msg.content.trim());
        }
      });

      this._status = "connected";
    } catch (err) {
      this._status = "error";
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
        // Best effort
      }
    }
    this.client = null;
    this.channel = null;
    this._status = "disconnected";
  }

  async requestPermission(request: PermissionRequest): Promise<PermissionReply> {
    if (!this.channel) {
      return { allowed: false, message: "Discord not connected" };
    }

    const inputStr = JSON.stringify(request.toolInput, null, 2);
    const truncated = inputStr.length > 1800 ? inputStr.slice(0, 1800) + "\n..." : inputStr;
    const project = request.cwd.split("/").filter(Boolean).pop() ?? "unknown";

    const text = [
      `**Agent needs permission**`,
      `**Project:** \`${project}\` (\`${request.cwd}\`)`,
      `**Session:** \`${request.sessionId}\``,
      `**Tool:** \`${request.toolName}\``,
      "```",
      truncated,
      "```",
      `Reply: **allow** or **deny**`,
    ].join("\n");

    try {
      const thread = await this.channel.send(text);
      // Create a thread for replies
      const replyThread = await thread.startThread({
        name: `Permission: ${request.toolName}`,
      });

      return await this.waitForThreadReply(replyThread);
    } catch {
      return { allowed: false, message: "Discord API error" };
    }
  }

  async postToolResult(result: ToolResult): Promise<void> {
    if (!this.channel) return;

    const truncOutput = result.output.length > 1800
      ? "..." + result.output.slice(-1800)
      : result.output;

    const text = [
      `**Tool completed:** \`${result.toolName}\``,
      "```",
      truncOutput || "(empty)",
      "```",
    ].join("\n");

    try {
      await this.channel.send(text);
    } catch {
      // Non-critical
    }
  }

  async postNotification(notification: SessionNotification): Promise<void> {
    if (!this.channel) return;

    const text = [
      `**${notification.type}** — Session \`${notification.sessionId}\``,
      notification.message,
    ].join("\n");

    try {
      await this.channel.send(text);
    } catch {
      // Non-critical
    }
  }

  onPrompt(handler: (prompt: string, sessionId?: string) => void): void {
    this.promptHandler = handler;
  }

  private async waitForThreadReply(thread: any): Promise<PermissionReply> {
    const timeout = this.config.timeout ?? 300000;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ allowed: false, message: "Timed out" });
      }, timeout);

      const onMessage = (msg: any) => {
        if (msg.channel.id !== thread.id || msg.author.bot) return;
        const text = msg.content.trim().toLowerCase();
        const allowWords = ["allow", "yes", "y", "approve", "ok"];
        const denyWords = ["deny", "no", "n", "reject", "block"];
        if (allowWords.includes(text)) {
          cleanup();
          resolve({ allowed: true });
        } else if (denyWords.includes(text)) {
          cleanup();
          resolve({ allowed: false, message: "Denied by user" });
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.client?.off("messageCreate", onMessage);
      };

      this.client?.on("messageCreate", onMessage);
    });
  }
}
