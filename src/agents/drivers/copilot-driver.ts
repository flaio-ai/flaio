import { BaseDriver, type AgentStatus, type SpawnConfig, type ModelInfo } from "./base-driver.js";
import { execSync } from "node:child_process";

export class CopilotDriver extends BaseDriver {
  readonly name = "copilot";
  readonly displayName = "Copilot CLI";
  readonly command = "copilot";

  async checkInstalled(): Promise<boolean> {
    try {
      execSync("which copilot", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  listModels(): ModelInfo[] {
    return [
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
      { id: "gpt-5.3-codex", displayName: "GPT 5.3 Codex" },
      { id: "gemini-3-pro", displayName: "Gemini 3 Pro" },
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

    if (options.prompt) {
      if (options.mode === "print") {
        args.push("-p", options.prompt);
      } else {
        // Interactive mode — pass prompt as positional arg
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

    // Copilot uses Ink-based TUI — detect prompt/input states
    if (/>\s*$/.test(lastLines)) {
      return "waiting_input";
    }

    // Spinner detection (Copilot uses braille spinners)
    const tail = raw.slice(-80);
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail)) {
      return "running";
    }

    // No output for 5+ seconds → likely waiting for input
    if (idleMs > 5000) {
      return "waiting_input";
    }

    return "running";
  }
}
