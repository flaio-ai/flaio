// ---------------------------------------------------------------------------
// TicketTracker — maps ticketId to session and status for the dev loop
// ---------------------------------------------------------------------------

export interface TrackedTicket {
  sessionId: string;
  status: string;
  ticketTitle: string;
}

export class TicketTracker {
  private ticketMap = new Map<string, TrackedTicket>();
  private sessionToTicket = new Map<string, string>();

  startPlanning(ticketId: string, sessionId: string, ticketTitle: string): void {
    this.ticketMap.set(ticketId, {
      sessionId,
      status: "planning",
      ticketTitle,
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

  updateStatus(ticketId: string, status: string): void {
    const entry = this.ticketMap.get(ticketId);
    if (entry) {
      entry.status = status;
    }
  }

  remove(ticketId: string): void {
    const entry = this.ticketMap.get(ticketId);
    if (entry) {
      this.sessionToTicket.delete(entry.sessionId);
      this.ticketMap.delete(ticketId);
    }
  }

  getAll(): Map<string, TrackedTicket> {
    return new Map(this.ticketMap);
  }
}

export const ticketTracker = new TicketTracker();
