import { execSync } from "node:child_process";

export type AgentStatus = "idle" | "starting" | "running" | "waiting_input" | "exited";

export interface SpawnConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export abstract class BaseDriver {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly command: string;

  /** Resolve the full path of the command binary */
  resolveCommand(): string {
    try {
      return execSync(`which ${this.command}`, { encoding: "utf-8" }).trim();
    } catch {
      return this.command;
    }
  }

  /** Check if this agent CLI is installed and available */
  abstract checkInstalled(): Promise<boolean>;

  /** Build spawn arguments for a new session */
  abstract buildSpawnArgs(options: { cwd: string; prompt?: string }): SpawnConfig;

  /** Build spawn arguments to resume an existing session */
  abstract buildResumeArgs(options: {
    cwd: string;
    sessionId: string;
    prompt?: string;
  }): SpawnConfig;

  /** Detect agent status from recent output */
  abstract detectStatus(recentOutput: string): AgentStatus;
}
