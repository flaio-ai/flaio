import { BaseDriver, type AgentStatus, type SpawnConfig, type ModelInfo } from "./base-driver.js";
import { execSync } from "node:child_process";

export class CodexDriver extends BaseDriver {
  readonly name = "codex";
  readonly displayName = "Codex CLI";
  readonly command = "codex";

  processMatchPattern(): RegExp {
    return /\bcodex\b(?!.*(?:app-server|Codex\.app|\.vscode))/;
  }

  async checkInstalled(): Promise<boolean> {
    try {
      execSync("which codex", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  listModels(): ModelInfo[] {
    return [
      { id: "o4-mini", displayName: "o4-mini" },
      { id: "o3", displayName: "o3" },
      { id: "gpt-4.1", displayName: "GPT-4.1" },
      { id: "gpt-5.3-codex", displayName: "GPT-5.3-Codex" },
      { id: "gpt-5.4", displayName: "GPT-5.4" },
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
        args.push("-q", options.prompt);
      } else {
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
    // Codex CLI doesn't support session resume — start fresh
    const args: string[] = [];
    if (options.prompt) {
      args.push(options.prompt);
    }
    return { command: this.resolveCommand(), args };
  }

  buildContinueArgs(_options: { cwd: string }): SpawnConfig {
    return { command: this.resolveCommand(), args: [] };
  }

  detectStatus(recentOutput: string, idleMs: number): AgentStatus {
    const raw = recentOutput.slice(-500);
    const lastLines = this.stripAnsi(raw);

    // Codex shows ">" prompt when waiting for input
    if (/>\s*$/.test(lastLines)) {
      return "waiting_input";
    }

    // Spinner characters indicate activity
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
