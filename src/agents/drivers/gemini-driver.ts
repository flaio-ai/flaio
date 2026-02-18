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

  buildContinueArgs(_options: { cwd: string }): SpawnConfig {
    return { command: this.resolveCommand(), args: ["--continue"] };
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
