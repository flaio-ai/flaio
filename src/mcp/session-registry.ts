// ---------------------------------------------------------------------------
// MCP session registry (CLI side)
//
// Each spawned ticket agent gets a random per-session token. The MCP server
// process (spawned by the agent CLI) presents it on every forwarded tool call;
// the hook server only accepts calls whose token is registered here, and the
// token alone decides which ticket/job/worktree the call applies to.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

export interface McpSessionBinding {
  ticketId: string;
  jobId: string | null;
  /** Ticket worktree. When unknown, the MCP server's reported cwd is used. */
  worktreePath: string | null;
  createdAt: number;
}

const sessions = new Map<string, McpSessionBinding>();

export function registerMcpSession(binding: Omit<McpSessionBinding, "createdAt">): string {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { ...binding, createdAt: Date.now() });
  return token;
}

export function resolveMcpSession(token: unknown): McpSessionBinding | null {
  if (typeof token !== "string" || token.length !== 64) return null;
  return sessions.get(token) ?? null;
}

/** Update a binding in place (e.g. when the worktree path becomes known). */
export function updateMcpSession(token: string, patch: Partial<Omit<McpSessionBinding, "createdAt">>): boolean {
  const cur = sessions.get(token);
  if (!cur) return false;
  sessions.set(token, { ...cur, ...patch });
  return true;
}

export function revokeMcpSession(token: string): void {
  sessions.delete(token);
}

/** Revoke every token bound to a ticket (call when the ticket's agent exits). */
export function revokeMcpSessionsForTicket(ticketId: string): void {
  for (const [token, b] of sessions) {
    if (b.ticketId === ticketId) sessions.delete(token);
  }
}

/** Test helper. */
export function _clearMcpSessions(): void {
  sessions.clear();
}
