import { execSync } from "node:child_process";

export type AgentStatus = "idle" | "starting" | "running" | "waiting_input" | "waiting_permission" | "exited";

export interface ModelInfo {
  id: string;
  displayName: string;
}

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

  /** Return the list of models supported by this driver */
  abstract listModels(): ModelInfo[];

  /** Build spawn arguments for a new session */
  abstract buildSpawnArgs(options: {
    cwd: string;
    prompt?: string;
    mode?: "interactive" | "print";
    allowedTools?: string[];
    model?: string;
  }): SpawnConfig;

  /** Build spawn arguments to resume an existing session */
  abstract buildResumeArgs(options: {
    cwd: string;
    sessionId: string;
    prompt?: string;
  }): SpawnConfig;

  /** Build spawn arguments to continue the most recent session */
  abstract buildContinueArgs(options: { cwd: string }): SpawnConfig;

  /** Detect agent status from recent output and ms since last output */
  abstract detectStatus(recentOutput: string, idleMs: number): AgentStatus;

  /** Strip ANSI escape sequences from text for pattern matching */
  protected stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B(?:\[[0-9;]*[a-zA-Z]|\].*?(?:\x07|\x1B\\)|\[[0-9;]*m)/g, "");
  }
}
