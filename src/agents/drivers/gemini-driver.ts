import {
  BaseDriver,
  inlineSystemPrompt,
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
 * BEST EFFORT — Gemini CLI is not installed in the build environment, so these
 * flags are NOT verified. Mapping follows the Gemini CLI docs:
 *   --approval-mode default|auto_edit|yolo|plan   (plan is newer/experimental)
 */
const GEMINI_APPROVAL_MODES: Record<AgentPermissionMode, string> = {
  plan: "plan",
  acceptEdits: "auto_edit",
  default: "default",
};

export class GeminiDriver extends BaseDriver {
  readonly name = "gemini";
  readonly displayName = "Gemini CLI";
  readonly command = "gemini";

  /**
   * BEST EFFORT (unverified). Gemini CLI can resume by session id/index
   * (`--resume <id>`), but cannot preset a session id, fork, take an MCP config
   * on the command line (MCP servers come from .gemini/settings.json) or append
   * a system prompt (GEMINI_SYSTEM_MD replaces it). The session id is learned
   * from sideband hook events after the first run.
   */
  override readonly ticketCapabilities: TicketCapabilities = {
    presetSessionId: false,
    resume: true,
    fork: false,
    permissionModes: true,
    mcpConfig: false,
    appendSystemPrompt: false,
  };

  async checkInstalled(): Promise<boolean> {
    try {
      execSync("which gemini", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  protected defaultModels(): ModelInfo[] {
    return [
      { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
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

    if (options.mode === "print") {
      args.push("--approval-mode", "plan");
    }

    if (options.prompt) {
      if (options.mode === "print") {
        args.push("-p", options.prompt);
      } else {
        args.push("-i", options.prompt);
      }
    }

    return { command: this.resolveCommand(), args };
  }

  buildResumeArgs(options: {
    cwd: string;
    sessionId: string;
    prompt?: string;
  }): SpawnConfig {
    // Gemini CLI uses --resume to continue a session
    const args = ["--resume", options.sessionId];
    if (options.prompt) {
      args.push("-p", options.prompt);
    }
    return { command: this.resolveCommand(), args };
  }

  /**
   * BEST EFFORT (unverified flags). First run: fresh session (id unknown until
   * the sideband reports it). Later runs: `--resume <id>` when an id is known.
   * mcpConfigPath and fork options are ignored (no CLI equivalent); system
   * instructions are inlined into the prompt.
   */
  override buildTicketSpawnArgs(options: TicketSpawnOptions): TicketSpawnConfig {
    const args: string[] = [];
    const resumed = options.resume && !!options.sessionId;
    if (resumed && options.sessionId) {
      args.push("--resume", options.sessionId);
    }
    if (options.model) {
      args.push("--model", options.model);
    }
    args.push("--approval-mode", GEMINI_APPROVAL_MODES[options.permissionMode]);
    const prompt = inlineSystemPrompt(options.prompt, options.appendSystemPrompt);
    args.push(options.print ? "-p" : "-i", prompt);
    return {
      command: this.resolveCommand(),
      args,
      agentSessionId: resumed ? options.sessionId : null,
      resumed,
    };
  }

  buildContinueArgs(_options: { cwd: string }): SpawnConfig {
    return { command: this.resolveCommand(), args: ["--resume", "latest"] };
  }

  detectStatus(recentOutput: string, idleMs: number): AgentStatus {
    const raw = recentOutput.slice(-500);
    const lastLines = this.stripAnsi(raw);

    // Gemini shows ">" or ">>>" when waiting for input
    if (/>{1,3}\s*$/.test(lastLines)) {
      return "waiting_input";
    }

    // Only check for spinner in the last ~80 chars (current line area)
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
