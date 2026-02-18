import { BaseDriver, type AgentStatus, type SpawnConfig } from "./base-driver.js";
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

  buildSpawnArgs(options: { cwd: string; prompt?: string }): SpawnConfig {
    const args: string[] = [];
    if (options.prompt) {
      args.push("-p", options.prompt);
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

  detectStatus(recentOutput: string): AgentStatus {
    const lastLines = recentOutput.slice(-500);

    // Gemini shows ">" or ">>>" when waiting for input
    if (/>{1,3}\s*$/.test(lastLines)) {
      return "waiting_input";
    }

    // Spinner characters indicate activity
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(lastLines)) {
      return "running";
    }

    return "running";
  }
}
