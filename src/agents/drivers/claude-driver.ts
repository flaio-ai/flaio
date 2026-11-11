import {
  BaseDriver,
  type AgentStatus,
  type SpawnConfig,
  type ModelInfo,
  type TicketCapabilities,
  type TicketSpawnConfig,
  type TicketSpawnOptions,
} from "./base-driver.js";
import type { AgentPermissionMode } from "../../contracts/agent-loop.js";
import { execSync } from "node:child_process";

/**
 * Contract permission mode -> `claude --permission-mode` value.
 * Verified against Claude Code 2.1.296: choices are acceptEdits, auto,
 * bypassPermissions, manual, dontAsk, plan; "default" is still accepted as a
 * (hidden) alias of the normal ask-before-acting mode, and is what older 2.x
 * releases call it, so we keep passing "default".
 */
const CLAUDE_PERMISSION_MODES: Record<AgentPermissionMode, string> = {
  plan: "plan",
  acceptEdits: "acceptEdits",
  default: "default",
};

export class ClaudeDriver extends BaseDriver {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly command = "claude";

  override readonly ticketCapabilities: TicketCapabilities = {
    presetSessionId: true,
    resume: true,
    fork: true,
    permissionModes: true,
    mcpConfig: true,
    appendSystemPrompt: true,
  };

  async checkInstalled(): Promise<boolean> {
    try {
      execSync("which claude", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  protected defaultModels(): ModelInfo[] {
    return [
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
    ];
  }

  buildSpawnArgs(options: {
    cwd: string;
    prompt?: string;
    mode?: "interactive" | "print";
    allowedTools?: string[];
    model?: string;
  }): SpawnConfig {
    const args: string[] = [];
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.allowedTools?.length) {
      args.push("--allowedTools", options.allowedTools.join(","));
    }
    if (options.prompt) {
      if (options.mode === "print") {
        // Non-interactive print mode — exits after output
        args.push("-p", options.prompt);
      } else {
        // Interactive TUI mode (default)
        args.push(options.prompt);
      }
    }
    return { command: this.resolveCommand(), args };
  }

  buildResumeArgs(options: {
    cwd: string;
    sessionId: string;
    prompt?: string;
  }): SpawnConfig {
    const args = ["--resume", options.sessionId];
    if (options.prompt) {
      args.push(options.prompt);
    }
    return { command: this.resolveCommand(), args };
  }

  /**
   * Ticket run args (flags verified with `claude --help`, Claude Code 2.1.296):
   *   first run:  --session-id <uuid>
   *   later runs: --resume <uuid>
   *   fork:       --resume <uuid> --fork-session [--session-id <new uuid>]
   *               (--session-id together with --resume is only accepted with --fork-session)
   *   --permission-mode <mode>, --mcp-config=<path>, --settings <path>,
   *   --append-system-prompt <text>, --model <id>, --allowedTools <list>, -p (print mode)
   * `--mcp-config` and `--allowedTools` are variadic: `--mcp-config` uses the
   * `=` form so it never swallows the next argument, and the prompt always
   * follows a `--` terminator (also protects prompts that start with "-").
   * `--settings` adds the ticket Stop hook on top of the user's own settings.
   */
  override buildTicketSpawnArgs(options: TicketSpawnOptions): TicketSpawnConfig {
    const args: string[] = [];
    let agentSessionId: string | null = null;
    const resumed = options.resume && !!options.sessionId;

    if (resumed && options.sessionId) {
      args.push("--resume", options.sessionId);
      if (options.forkSession) {
        args.push("--fork-session");
        if (options.forkSessionId) {
          args.push("--session-id", options.forkSessionId);
          agentSessionId = options.forkSessionId;
        }
        // Fork without a preset id: the new id arrives via sideband metadata.
      } else {
        agentSessionId = options.sessionId;
      }
    } else if (options.sessionId) {
      args.push("--session-id", options.sessionId);
      agentSessionId = options.sessionId;
    }

    if (options.model) {
      args.push("--model", options.model);
    }
    args.push("--permission-mode", CLAUDE_PERMISSION_MODES[options.permissionMode]);
    if (options.appendSystemPrompt?.trim()) {
      args.push("--append-system-prompt", options.appendSystemPrompt.trim());
    }
    if (options.mcpConfigPath) {
      args.push(`--mcp-config=${options.mcpConfigPath}`);
    }
    if (options.settingsPath) {
      args.push("--settings", options.settingsPath);
    }
    if (options.allowedTools?.length) {
      args.push("--allowedTools", options.allowedTools.join(","));
    }
    if (options.print) {
      args.push("-p");
    }
    args.push("--", options.prompt);

    return { command: this.resolveCommand(), args, agentSessionId, resumed };
  }

  buildContinueArgs(_options: { cwd: string }): SpawnConfig {
    return { command: this.resolveCommand(), args: ["--continue"] };
  }

  detectStatus(recentOutput: string, idleMs: number): AgentStatus {
    const raw = recentOutput.slice(-500);
    const lastLines = this.stripAnsi(raw);

    // Claude shows ">" prompt when waiting for input
    if (/>\s*$/.test(lastLines)) {
      return "waiting_input";
    }

    // Only check for spinner in the last ~80 chars (current line area)
    // to avoid matching stale spinner chars from earlier output
    const tail = raw.slice(-80);
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail)) {
      return "running";
    }

    // No output for 5+ seconds likely means waiting for input
    if (idleMs > 5000) {
      return "waiting_input";
    }

    return "running";
  }
}
