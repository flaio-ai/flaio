import { BaseDriver, type AgentStatus, type SpawnConfig } from "./base-driver.js";
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
