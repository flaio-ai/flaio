// ---------------------------------------------------------------------------
// TicketTracker — maps ticketId to PTY session, worktree and the ticket's
// resumable agent session. Persisted to ~/.config/flaio/tickets.json so the
// ticket ↔ agent session ↔ worktree map survives CLI restarts.
// ---------------------------------------------------------------------------

import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JobKind, TicketAgentSession } from "../contracts/agent-loop.js";
import { removeWorktree } from "./worktree-manager.js";
import { getConfigDir } from "../config/config.js";
import { makeDebugLog } from "../connectors/debug.js";

const debugLog = makeDebugLog("tickets");

export interface ActiveJobInfo {
  id: string;
  kind: JobKind;
  /** Run started from a legacy relay_start_* / relay_request_changes message. */
  legacy: boolean;
  startedAt: number;
}

export interface TrackedTicket {
  /** Flaio PTY session hosting the agent (runtime only; null after restart). */
  sessionId: string | null;
  status: string;
  ticketTitle: string;
  originalCwd: string;
  worktreePath: string | null;
  branchName: string | null;
  /** Driver/model/worktree preference of the last run (for resuming without a full request). */
  driverName?: string;
  model?: string | null;
  useWorktree?: boolean;
  /** The ticket's resumable agent CLI session. */
  agentSession?: TicketAgentSession | null;
  /** cwd the agent session was created in (Claude stores sessions per project dir). */
  agentCwd?: string | null;
  /** Job currently running (null when idle). Runtime only; cleared on load. */
  activeJob?: ActiveJobInfo | null;
  /** Kind of the most recent job run for this ticket. */
  lastJobKind?: JobKind;
  /** Number of plans submitted for this ticket (plan_submitted iteration). */
  planIterations?: number;
  /** epoch ms the ticket's last job ended (completed, failed, cancelled). Drives cleanup. */
  lastJobFinishedAt?: number;
  updatedAt?: number;
}

const TicketAgentSessionSchema = z.object({
  id: z.string(),
  driver: z.string(),
  transcriptPath: z.string().optional(),
  runnerId: z.string().optional(),
  resumeCount: z.number(),
  lastResumedAt: z.number().optional(),
});

const TrackedTicketSchema = z.object({
  sessionId: z.string().nullable().optional(),
  status: z.string(),
  ticketTitle: z.string().default(""),
  originalCwd: z.string().default(""),
  worktreePath: z.string().nullable().default(null),
  branchName: z.string().nullable().default(null),
  driverName: z.string().optional(),
  model: z.string().nullable().optional(),
  useWorktree: z.boolean().optional(),
  agentSession: TicketAgentSessionSchema.nullable().optional(),
  agentCwd: z.string().nullable().optional(),
  lastJobKind: z.enum(["plan", "implement", "revise_plan", "review_fixes", "ci_fix", "answer_resume"]).optional(),
  planIterations: z.number().optional(),
  lastJobFinishedAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

const TicketsFileSchema = z.object({
  version: z.literal(1),
  runnerId: z.string().optional(),
  tickets: z.record(z.string(), z.unknown()),
});

export interface TicketTrackerOptions {
  /** File to persist to. Default: <config dir>/tickets.json. null disables persistence. */
  filePath?: string | null;
}

export function defaultTicketsFilePath(): string {
  return path.join(getConfigDir(), "tickets.json");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Write a file atomically: temp file in the same dir, fsync, then rename over the target. */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const fh = await fsp.open(tmp, "w", 0o600);
    try {
      await fh.writeFile(data, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export class TicketTracker {
  private ticketMap = new Map<string, TrackedTicket>();
  private sessionToTicket = new Map<string, string>();
  private readonly filePath: string | null;
  private runnerId: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(options: TicketTrackerOptions = {}) {
    this.filePath = options.filePath === undefined ? defaultTicketsFilePath() : options.filePath;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Load tickets.json and reconcile: entries whose worktree no longer exists
   * (or whose project dir is gone) are dropped; PTY sessions and active jobs
   * from the previous process are cleared. Safe to call more than once.
   */
  async load(): Promise<void> {
    if (!this.filePath) {
      this.loaded = true;
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(this.filePath, "utf-8"));
    } catch {
      this.loaded = true;
      return; // Missing or corrupt — start empty
    }
    const parsed = TicketsFileSchema.safeParse(raw);
    if (!parsed.success) {
      debugLog(`tickets: ignoring invalid ${this.filePath}`);
      this.loaded = true;
      return;
    }
    if (parsed.data.runnerId) this.runnerId = parsed.data.runnerId;

    let dropped = 0;
    for (const [ticketId, value] of Object.entries(parsed.data.tickets)) {
      const entry = TrackedTicketSchema.safeParse(value);
      if (!entry.success) {
        dropped++;
        continue;
      }
      const e = entry.data;
      const location = e.worktreePath ?? (e.originalCwd || null);
      if (location && !(await pathExists(location))) {
        dropped++;
        continue;
      }
      // Never clobber state created in this process before load() finished.
      if (this.ticketMap.has(ticketId)) continue;
      this.ticketMap.set(ticketId, {
        ...e,
        sessionId: null,
        activeJob: null,
        status: e.status === "planning" || e.status === "implementing" ? "interrupted" : e.status,
      });
    }
    this.loaded = true;
    if (dropped > 0) {
      debugLog(`tickets: reconciled — dropped ${dropped} stale entr${dropped === 1 ? "y" : "ies"}`);
      await this.persist();
    }
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  private serialize(): string {
    const tickets: Record<string, unknown> = {};
    for (const [id, entry] of this.ticketMap) {
      const { activeJob: _activeJob, ...rest } = entry;
      tickets[id] = rest;
    }
    return JSON.stringify({ version: 1, runnerId: this.runnerId ?? undefined, tickets }, null, 2) + "\n";
  }

  /** Persist the current map (serialized, atomic). Resolves when this write hit disk. */
  persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    const filePath = this.filePath;
    const data = this.serialize();
    this.writeChain = this.writeChain
      .then(() => writeFileAtomic(filePath, data))
      .catch((err) => debugLog(`tickets: persist failed: ${err}`));
    return this.writeChain;
  }

  /** Wait for pending writes (tests / shutdown). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private touch(entry: TrackedTicket): void {
    entry.updatedAt = Date.now();
    void this.persist();
  }

  // -------------------------------------------------------------------------
  // Runner identity (stable per machine/config dir)
  // -------------------------------------------------------------------------

  getRunnerId(): string {
    if (!this.runnerId) {
      this.runnerId = `runner-${randomUUID()}`;
      void this.persist();
    }
    return this.runnerId;
  }

  // -------------------------------------------------------------------------
  // Ticket state
  // -------------------------------------------------------------------------

  /** Create or update a ticket entry. Unspecified fields keep their value. */
  upsert(ticketId: string, patch: Partial<TrackedTicket>): TrackedTicket {
    const existing = this.ticketMap.get(ticketId);
    const entry: TrackedTicket = existing ?? {
      sessionId: null,
      status: "idle",
      ticketTitle: "",
      originalCwd: "",
      worktreePath: null,
      branchName: null,
    };
    if (patch.sessionId !== undefined && entry.sessionId && entry.sessionId !== patch.sessionId) {
      this.sessionToTicket.delete(entry.sessionId);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (entry as unknown as Record<string, unknown>)[k] = v;
    }
    if (entry.sessionId) this.sessionToTicket.set(entry.sessionId, ticketId);
    this.ticketMap.set(ticketId, entry);
    this.touch(entry);
    return entry;
  }

  get(ticketId: string): TrackedTicket | undefined {
    return this.ticketMap.get(ticketId);
  }

  startPlanning(
    ticketId: string,
    sessionId: string,
    ticketTitle: string,
    originalCwd: string,
    worktreePath: string | null = null,
    branchName: string | null = null,
  ): void {
    this.upsert(ticketId, {
      sessionId,
      status: "planning",
      ticketTitle,
      originalCwd,
      worktreePath,
      branchName,
    });
  }

  startImplementation(ticketId: string, sessionId: string): void {
    this.upsert(ticketId, { sessionId, status: "implementing" });
  }

  setAgentSession(ticketId: string, agentSession: TicketAgentSession | null, agentCwd?: string | null): void {
    this.upsert(ticketId, { agentSession, agentCwd: agentCwd ?? undefined });
  }

  getAgentSession(ticketId: string): TicketAgentSession | null {
    return this.ticketMap.get(ticketId)?.agentSession ?? null;
  }

  setActiveJob(ticketId: string, job: ActiveJobInfo | null): void {
    const entry = this.ticketMap.get(ticketId);
    if (!entry) return;
    entry.activeJob = job;
  }

  /** Record that the ticket's current job ended (retention clock for cleanup). */
  markJobFinished(ticketId: string, at: number = Date.now()): void {
    const entry = this.ticketMap.get(ticketId);
    if (!entry) return;
    entry.lastJobFinishedAt = at;
    this.touch(entry);
  }

  /** Increment and return the plan iteration counter. */
  nextPlanIteration(ticketId: string): number {
    const entry = this.ticketMap.get(ticketId);
    if (!entry) return 0;
    const n = entry.planIterations ?? 0;
    entry.planIterations = n + 1;
    this.touch(entry);
    return n;
  }

  /** Drop the PTY session mapping (session exited / closed). */
  clearSession(ticketId: string, sessionId: string): void {
    const entry = this.ticketMap.get(ticketId);
    if (entry?.sessionId === sessionId) {
      entry.sessionId = null;
      this.touch(entry);
    }
    this.sessionToTicket.delete(sessionId);
  }

  getSessionForTicket(ticketId: string): string | undefined {
    return this.ticketMap.get(ticketId)?.sessionId ?? undefined;
  }

  getTicketForSession(sessionId: string): string | undefined {
    return this.sessionToTicket.get(sessionId);
  }

  getWorktreeInfo(ticketId: string): { worktreePath: string | null; branchName: string | null; originalCwd: string } | undefined {
    const entry = this.ticketMap.get(ticketId);
    if (!entry) return undefined;
    return {
      worktreePath: entry.worktreePath,
      branchName: entry.branchName,
      originalCwd: entry.originalCwd,
    };
  }

  /**
   * Update the ticket status. Note: "done" no longer schedules worktree
   * removal — the worktree (and the agent session bound to its cwd) is kept
   * so review_fixes / ci_fix jobs can resume the same session.
   */
  updateStatus(ticketId: string, status: string): void {
    const entry = this.ticketMap.get(ticketId);
    if (entry) {
      entry.status = status;
      this.touch(entry);
    }
  }

  async remove(ticketId: string): Promise<void> {
    const entry = this.ticketMap.get(ticketId);
    if (!entry) return;

    if (entry.worktreePath && entry.originalCwd) {
      await removeWorktree(entry.originalCwd, ticketId);
    }

    if (entry.sessionId) this.sessionToTicket.delete(entry.sessionId);
    this.ticketMap.delete(ticketId);
    await this.persist();
  }

  getAll(): Map<string, TrackedTicket> {
    return new Map(this.ticketMap);
  }

  /** Get all unique project cwds being tracked (for shutdown auto-save) */
  getTrackedProjectCwds(): string[] {
    const cwds = new Set<string>();
    for (const entry of this.ticketMap.values()) {
      if (entry.originalCwd) {
        cwds.add(entry.originalCwd);
      }
    }
    return [...cwds];
  }

  /** Kept for API compatibility (no timers any more). */
  clearTimers(): void {}
}

export const ticketTracker = new TicketTracker();
