import { BaseDriver, type AgentStatus, type SpawnConfig, type ModelInfo } from "./base-driver.js";
import { execSync } from "node:child_process";

export class GeminiDriver extends BaseDriver {
  readonly name = "gemini";
  readonly displayName = "Gemini CLI";
  readonly command = "gemini";

  async checkInstalled(): Promise<boolean> {
    try {
      execSync("which gemini", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  listModels(): ModelInfo[] {
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
