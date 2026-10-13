// ---------------------------------------------------------------------------
// Integration seams for the job runner (WS-A1 ⇄ WS-A2)
//
// WS-A2 owns src/workspace (ticket workspace files) and src/mcp (Flaio MCP
// server). Until those land, the job runner uses the minimal defaults below.
// At integration, A2 replaces them via JobRunner.setTicketWorkspace() /
// JobRunner.setMcpSpawnConfigProvider() (or RelayClient's pass-throughs).
// ---------------------------------------------------------------------------

import fsp from "node:fs/promises";
import path from "node:path";
import { TICKET_WORKSPACE_DIR, TICKET_WORKSPACE_FILES } from "../../contracts/mcp-tools.js";
import { ensureFlaioExcluded } from "../worktree-manager.js";

/** Writes ticket workspace files into a worktree. */
export interface TicketWorkspaceWriter {
  /**
   * Write the brief to `<worktree>/.flaio/ticket/brief.md`.
   * Returns the absolute path written.
   */
  writeBrief(worktreePath: string, ticketId: string, markdown: string): Promise<string>;
  /** Ensure `.flaio/` is excluded from commits (`.git/info/exclude`). */
  ensureExcluded(worktreePath: string): Promise<void>;
}

/** Default writer: plain file write + info/exclude entry. */
export const defaultTicketWorkspace: TicketWorkspaceWriter = {
  async writeBrief(worktreePath, _ticketId, markdown) {
    const dir = path.join(worktreePath, TICKET_WORKSPACE_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, TICKET_WORKSPACE_FILES.brief);
    await fsp.writeFile(file, markdown.endsWith("\n") ? markdown : markdown + "\n", "utf-8");
    return file;
  },
  async ensureExcluded(worktreePath) {
    await ensureFlaioExcluded(worktreePath);
  },
};

/** What the agent needs to attach the Flaio MCP server for a ticket job. */
export interface McpSpawnConfig {
  /** Path to an MCP config JSON passed to the agent (`claude --mcp-config <path>`). */
  mcpConfigPath?: string;
  /** Extra env for the agent process (inherited by stdio MCP servers). */
  env?: Record<string, string>;
}

export type McpSpawnConfigProvider = (
  ticketId: string,
  jobId: string,
) => McpSpawnConfig | undefined | Promise<McpSpawnConfig | undefined>;

/** Stub until WS-A2's getMcpSpawnConfig lands: no MCP server attached. */
export const noMcpSpawnConfig: McpSpawnConfigProvider = () => undefined;
