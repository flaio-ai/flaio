import { BaseDriver, type AgentStatus, type SpawnConfig, type ModelInfo } from "./base-driver.js";
import { execSync } from "node:child_process";

// Match the `codex` CLI but not the desktop app, its app-server, or the VS Code extension host.
// The exclusions can appear before or after the command name in a ps line, so anchor the lookahead.
const CODEX_PROCESS_PATTERN = /^(?!.*(?:app-server|Codex\.app|\.vscode)).*\bcodex\b/;

export class CodexDriver extends BaseDriver {
  readonly name = "codex";
  readonly displayName = "Codex CLI";
  readonly command = "codex";

  processMatchPattern(): RegExp {
    return CODEX_PROCESS_PATTERN;
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
      { id: "gpt-6-astra", displayName: "GPT-6 Astra" },
      { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
      { id: "gpt-6.1-terra", displayName: "GPT-6.1 Terra" },
      { id: "gpt-6-luna", displayName: "GPT-6 Luna" },
    ];
  }

  buildSpawnArgs(options: {
    cwd: string;
    prompt?: string;
    mode?: "interactive" | "print";
    allowedTools?: string[];
    model?: string;
  }): SpawnConfig {
    // Non-interactive runs use the `exec` subcommand: `codex exec [OPTIONS] [PROMPT]`
    const args: string[] = options.mode === "print" ? ["exec"] : [];
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.prompt) {
      args.push(options.prompt);
    }
    return { command: this.resolveCommand(), args };
  }

  buildResumeArgs(options: {
    cwd: string;
    sessionId: string;
    prompt?: string;
  }): SpawnConfig {
    // `codex resume <SESSION_ID>` — interactive resume takes no follow-up prompt
    return { command: this.resolveCommand(), args: ["resume", options.sessionId] };
  }

  buildContinueArgs(_options: { cwd: string }): SpawnConfig {
    // Most recent session in the current directory
    return { command: this.resolveCommand(), args: ["resume", "--last"] };
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
