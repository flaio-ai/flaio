// ---------------------------------------------------------------------------
// Ticket cleanup — keeps tickets.json and .flaio/worktrees from growing forever.
//
// Removes the tracker entry (and the Flaio-created worktree, branch kept) of a
// ticket whose last job ended long enough ago. Conservative: a ticket that is
// running, or whose worktree has uncommitted changes or commits on no remote,
// is never touched — it is only logged.
// ---------------------------------------------------------------------------

import { execFile as execFileCb } from "node:child_process";
import fsp from "node:fs/promises";
import { promisify } from "node:util";
import type { TicketTracker, TrackedTicket } from "./ticket-tracker.js";
import { makeDebugLog } from "../connectors/debug.js";

const execFile = promisify(execFileCb);
const debugLog = makeDebugLog("tickets");

export const DAY_MS = 24 * 60 * 60 * 1000;

export type WorktreeCheck = { safe: true } | { safe: false; reason: string };

/**
 * Whether a worktree can be removed without losing work: no uncommitted or
 * untracked changes and no commit that is on no remote. Any git error counts
 * as unsafe.
 */
export async function checkWorktreeRemovable(worktreePath: string): Promise<WorktreeCheck> {
  try {
    const status = await execFile("git", ["status", "--porcelain"], { cwd: worktreePath, timeout: 10_000 });
    if (status.stdout.trim()) return { safe: false, reason: "uncommitted changes" };
    const ahead = await execFile("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], {
      cwd: worktreePath,
      timeout: 10_000,
    });
    const n = parseInt(ahead.stdout.trim(), 10);
    if (!Number.isFinite(n)) return { safe: false, reason: "could not count unpushed commits" };
    if (n > 0) return { safe: false, reason: `${n} commit(s) not on any remote` };
    return { safe: true };
  } catch (err) {
    return { safe: false, reason: `git check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface TicketCleanupDeps {
  tracker: Pick<TicketTracker, "getAll" | "remove">;
  /** A job for the ticket is setting up or its agent is attached. */
  isBusy(ticketId: string): boolean;
  now?: () => number;
  checkWorktree?: (worktreePath: string) => Promise<WorktreeCheck>;
}

export interface TicketCleanupOptions {
  /** Only tickets whose last job ended at least this long ago. */
  retentionMs: number;
  /** Restrict to these tickets (e.g. a cancel for a done ticket). */
  only?: string[];
}

export interface TicketCleanupResult {
  removed: string[];
  kept: { ticketId: string; reason: string }[];
}

function lastActivity(entry: TrackedTicket): number | null {
  return entry.lastJobFinishedAt ?? entry.updatedAt ?? null;
}

export async function cleanupTickets(deps: TicketCleanupDeps, opts: TicketCleanupOptions): Promise<TicketCleanupResult> {
  const now = (deps.now ?? Date.now)();
  const check = deps.checkWorktree ?? checkWorktreeRemovable;
  const result: TicketCleanupResult = { removed: [], kept: [] };
  const all = deps.tracker.getAll();
  const ids = opts.only ? opts.only.filter((id) => all.has(id)) : [...all.keys()];

  for (const ticketId of ids) {
    const entry = all.get(ticketId);
    if (!entry) continue;
    if (deps.isBusy(ticketId) || entry.sessionId || entry.activeJob) continue;
    const last = lastActivity(entry);
    // Unknown age: keep (conservative).
    if (last === null || now - last < opts.retentionMs) continue;

    if (entry.worktreePath && (await exists(entry.worktreePath))) {
      const verdict = await check(entry.worktreePath);
      if (!verdict.safe) {
        debugLog(`tickets: keeping worktree of ${ticketId} at ${entry.worktreePath}: ${verdict.reason}`);
        result.kept.push({ ticketId, reason: verdict.reason });
        continue;
      }
    }
    // Re-check: a job may have started while git ran.
    if (deps.isBusy(ticketId)) continue;
    await deps.tracker.remove(ticketId);
    debugLog(`tickets: cleaned up ${ticketId}${entry.worktreePath ? ` (worktree ${entry.worktreePath})` : ""}`);
    result.removed.push(ticketId);
  }
  return result;
}
