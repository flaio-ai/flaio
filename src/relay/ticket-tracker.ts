// ---------------------------------------------------------------------------
// TicketTracker — maps ticketId to session and status for the dev loop
// ---------------------------------------------------------------------------

import { removeWorktree } from "./worktree-manager.js";

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
    }
  }

  async remove(ticketId: string): Promise<void> {
    const entry = this.ticketMap.get(ticketId);
    if (!entry) return;

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
}

export const ticketTracker = new TicketTracker();
