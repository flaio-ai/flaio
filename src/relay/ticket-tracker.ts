// ---------------------------------------------------------------------------
// TicketTracker — maps ticketId to session and status for the dev loop
// ---------------------------------------------------------------------------

import { removeWorktree } from "./worktree-manager.js";
import { getSessionInstance } from "../store/app-store.js";

export interface TrackedTicket {
  sessionId: string;
  status: string;
  ticketTitle: string;
  originalCwd: string;
  worktreePath: string | null;
  branchName: string | null;
}

export class TicketTracker {
  private ticketMap = new Map<string, TrackedTicket>();
  private sessionToTicket = new Map<string, string>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  startPlanning(
    ticketId: string,
    sessionId: string,
    ticketTitle: string,
    originalCwd: string,
    worktreePath: string | null = null,
    branchName: string | null = null,
  ): void {
    this.ticketMap.set(ticketId, {
      sessionId,
      status: "planning",
      ticketTitle,
      originalCwd,
      worktreePath,
      branchName,
    });
    this.sessionToTicket.set(sessionId, ticketId);
  }

  startImplementation(ticketId: string, sessionId: string): void {
    const existing = this.ticketMap.get(ticketId);
    if (existing) {
      // Remove old session mapping if session changed
      if (existing.sessionId !== sessionId) {
        this.sessionToTicket.delete(existing.sessionId);
      }
      existing.sessionId = sessionId;
      existing.status = "implementing";
    } else {
      this.ticketMap.set(ticketId, {
        sessionId,
        status: "implementing",
        ticketTitle: "",
        originalCwd: "",
        worktreePath: null,
        branchName: null,
      });
    }
    this.sessionToTicket.set(sessionId, ticketId);
  }

  getSessionForTicket(ticketId: string): string | undefined {
    return this.ticketMap.get(ticketId)?.sessionId;
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

  updateStatus(ticketId: string, status: string): void {
    const entry = this.ticketMap.get(ticketId);
    if (entry) {
      entry.status = status;

      // Auto-cleanup completed tickets after 5 minutes
      if (status === "done") {
        this.scheduleCleanup(ticketId);
      } else {
        // If status changed away from done, cancel pending cleanup
        const existing = this.cleanupTimers.get(ticketId);
        if (existing) {
          clearTimeout(existing);
          this.cleanupTimers.delete(ticketId);
        }
      }
    }
  }

  private scheduleCleanup(ticketId: string): void {
    const existing = this.cleanupTimers.get(ticketId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.cleanupTimers.delete(ticketId);
      const entry = this.ticketMap.get(ticketId);
      if (entry?.status !== "done") return;

      // Verify session is actually dead before removing worktree
      const instance = getSessionInstance(entry.sessionId);
      if (instance) {
        // Session still alive — reschedule instead of removing
        this.scheduleCleanup(ticketId);
        return;
      }

      void this.remove(ticketId);
    }, 5 * 60 * 1000);
    timer.unref();
    this.cleanupTimers.set(ticketId, timer);
  }

  async remove(ticketId: string): Promise<void> {
    const entry = this.ticketMap.get(ticketId);
    if (!entry) return;

    // Clear any pending cleanup timer
    const timer = this.cleanupTimers.get(ticketId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(ticketId);
    }

    // Clean up worktree if one exists
    if (entry.worktreePath && entry.originalCwd) {
      await removeWorktree(entry.originalCwd, ticketId);
    }

    this.sessionToTicket.delete(entry.sessionId);
    this.ticketMap.delete(ticketId);
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

  /** Clear all pending cleanup timers (for shutdown) */
  clearTimers(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
  }
}

export const ticketTracker = new TicketTracker();
