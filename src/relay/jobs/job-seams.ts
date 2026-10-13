// ---------------------------------------------------------------------------
// Integration seams for the job runner (WS-A1 ⇄ WS-A2)
//
// WS-A2 owns src/workspace (ticket workspace files) and src/mcp (Flaio MCP
// server). Until those land, the job runner uses the minimal defaults below.
// At integration, A2 replaces them via JobRunner.setTicketWorkspace() /
// JobRunner.setMcpSpawnConfigProvider() (or RelayClient's pass-throughs).
// ---------------------------------------------------------------------------

import fs from "node:fs";
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
    const dir = await ensureRealDir(worktreePath, TICKET_WORKSPACE_DIR);
    const file = path.join(dir, TICKET_WORKSPACE_FILES.brief);
    // O_NOFOLLOW: a brief.md symlink in the repo must not redirect the write.
    const flags =
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0);
    const fh = await fsp.open(file, flags, 0o644);
    try {
      await fh.writeFile(markdown.endsWith("\n") ? markdown : markdown + "\n", "utf-8");
    } finally {
      await fh.close();
    }
    return file;
  },
  async ensureExcluded(worktreePath) {
    await ensureFlaioExcluded(worktreePath);
  },
};

/**
 * Create `<root>/<rel>` one segment at a time, refusing any segment that is a
 * symlink or not a directory, so a repo that ships `.flaio` (or
 * `.flaio/ticket`) as a symlink cannot make Flaio write outside the worktree.
 */
async function ensureRealDir(root: string, rel: string): Promise<string> {
  let dir = path.resolve(root);
  for (const segment of rel.split("/").filter(Boolean)) {
    dir = path.join(dir, segment);
    let st: fs.Stats | null = null;
    try {
      st = await fsp.lstat(dir);
    } catch {
      // Missing — created below
    }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      throw new Error(`Refusing to write ticket workspace: ${dir} is not a plain directory`);
    }
    if (!st) await fsp.mkdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  }
  return dir;
}

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
