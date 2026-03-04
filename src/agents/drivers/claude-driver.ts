import { BaseDriver, type AgentStatus, type SpawnConfig, type ModelInfo } from "./base-driver.js";
import { execSync } from "node:child_process";

export class ClaudeDriver extends BaseDriver {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly command = "claude";

  async checkInstalled(): Promise<boolean> {
    try {
      execSync("which claude", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  listModels(): ModelInfo[] {
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

    // Various activity indicators (spinners)
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(raw)) {
      return "running";
    }

    // No output for 3+ seconds likely means waiting for input
    if (idleMs > 3000) {
      return "waiting_input";
    }

    return "running";
  }
}
