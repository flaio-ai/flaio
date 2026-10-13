import { execSync } from "node:child_process";
import { stripAnsi } from "../../strip-ansi.js";
import type { AgentPermissionMode } from "../../contracts/agent-loop.js";
import { settingsStore } from "../../store/settings-store.js";

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

/** Options for spawning an agent for a ticket job (see docs/virtual-dev/CONTRACTS.md). */
export interface TicketSpawnOptions {
  cwd: string;
  /**
   * Agent CLI session id. With `resume: false` this is the id to assign to the
   * new session (drivers that can preset ids); with `resume: true` it is the
   * session to resume. null = let the agent pick (id learned later via sideband).
   */
  sessionId: string | null;
  resume: boolean;
  permissionMode: AgentPermissionMode;
  prompt: string;
  model?: string | null;
  /** Path to an MCP config JSON (Flaio MCP server), when available. */
  mcpConfigPath?: string;
  /** Path to an agent settings file adding the ticket Stop hook (Claude: --settings), when available. */
  settingsPath?: string;
  /** Extra system prompt text (org/ticket system instructions). */
  appendSystemPrompt?: string;
  /** When resuming, branch into a new session instead of appending to the original. */
  forkSession?: boolean;
  /** With forkSession: the id to give the forked session (drivers that can preset ids). */
  forkSessionId?: string;
  /** Non-interactive print mode (process exits when done). Default: interactive TUI. */
  print?: boolean;
  /** Tool allow-list (print-mode planning). */
  allowedTools?: string[];
}

export interface TicketSpawnConfig extends SpawnConfig {
  /** The agent session id the spawned process will use, when known up front. */
  agentSessionId: string | null;
  /** True when the spawn resumes an existing agent session. */
  resumed: boolean;
}

/** What a driver can do for ticket runs. Anything false falls back to a fresh session + brief. */
export interface TicketCapabilities {
  /** Can assign the session id up front (Claude: --session-id). */
  presetSessionId: boolean;
  /** Can resume a session by id. */
  resume: boolean;
  /** Can branch a resumed session into a new id. */
  fork: boolean;
  /** Honours permissionMode via a CLI flag. */
  permissionModes: boolean;
  /** Accepts an MCP config path on the command line. */
  mcpConfig: boolean;
  /** Accepts extra system prompt text on the command line. */
  appendSystemPrompt: boolean;
}

export const NO_TICKET_CAPABILITIES: TicketCapabilities = Object.freeze({
  presetSessionId: false,
  resume: false,
  fork: false,
  permissionModes: false,
  mcpConfig: false,
  appendSystemPrompt: false,
});

/** Prepend system instructions to the prompt for drivers that cannot take them as a flag. */
export function inlineSystemPrompt(prompt: string, appendSystemPrompt?: string): string {
  if (!appendSystemPrompt?.trim()) return prompt;
  return `${appendSystemPrompt.trim()}\n\n---\n\n${prompt}`;
}

export abstract class BaseDriver {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly command: string;

  /** Ticket-run capabilities; drivers override what they support. */
  readonly ticketCapabilities: TicketCapabilities = NO_TICKET_CAPABILITIES;

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

  /** Built-in model list, used when config has no `agents.models[<driver>]` override. */
  protected abstract defaultModels(): ModelInfo[];

  /** Models offered for this driver: `agents.models[<driver>]` from config, else the built-in default. */
  listModels(): ModelInfo[] {
    try {
      const override = settingsStore.getState().config.agents.models?.[this.name];
      if (override && override.length > 0) return override.map((m) => ({ ...m }));
    } catch {
      // Config unavailable — fall through to defaults
    }
    return this.defaultModels();
  }

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

  /**
   * Build spawn arguments for a ticket job run.
   *
   * Default for drivers without session/permission support: a fresh session
   * with the system instructions inlined into the prompt. Session id, resume,
   * permission mode and MCP config are ignored; the prompt points the agent
   * at .flaio/ticket/brief.md so ticket context survives without resume.
   */
  buildTicketSpawnArgs(options: TicketSpawnOptions): TicketSpawnConfig {
    const config = this.buildSpawnArgs({
      cwd: options.cwd,
      prompt: inlineSystemPrompt(options.prompt, options.appendSystemPrompt),
      mode: options.print ? "print" : "interactive",
      allowedTools: options.allowedTools,
      model: options.model ?? undefined,
    });
    return { ...config, agentSessionId: null, resumed: false };
  }

  /** Detect agent status from recent output and ms since last output */
  abstract detectStatus(recentOutput: string, idleMs: number): AgentStatus;

  /** Strip ANSI escape sequences from text for pattern matching */
  protected stripAnsi(text: string): string {
    return stripAnsi(text);
  }
}
