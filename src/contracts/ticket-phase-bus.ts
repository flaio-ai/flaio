// ---------------------------------------------------------------------------
// TicketPhaseBus (Stage 0)
//
// The seam between WS-A2 (MCP server + workspace, which EMITS) and WS-A1
// (session continuity in relay-client, which LISTENS and forwards to the
// relay). Neither side imports the other; both import this file.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import type { z } from "zod";
import type {
  AskQuestionInput,
  CompletePhaseInput,
  RecordDecisionInput,
  ReportProgressInput,
  SubmitPlanInput,
} from "./mcp-tools.js";

export interface TicketPhaseBusEvents {
  plan_submitted: { ticketId: string; jobId: string | null; plan: z.infer<typeof SubmitPlanInput> };
  question: { ticketId: string; jobId: string | null; questionId: string; question: z.infer<typeof AskQuestionInput> };
  decision: { ticketId: string; jobId: string | null; decision: z.infer<typeof RecordDecisionInput> };
  progress: { ticketId: string; jobId: string | null; progress: z.infer<typeof ReportProgressInput> };
  phase_complete: { ticketId: string; jobId: string | null; completion: z.infer<typeof CompletePhaseInput> };
}

export type TicketPhaseBusEvent = keyof TicketPhaseBusEvents;

export class TicketPhaseBus extends EventEmitter {
  emitEvent<E extends TicketPhaseBusEvent>(event: E, payload: TicketPhaseBusEvents[E]): boolean {
    return this.emit(event, payload);
  }

  onEvent<E extends TicketPhaseBusEvent>(event: E, listener: (payload: TicketPhaseBusEvents[E]) => void): this {
    return this.on(event, listener);
  }

  offEvent<E extends TicketPhaseBusEvent>(event: E, listener: (payload: TicketPhaseBusEvents[E]) => void): this {
    return this.off(event, listener);
  }
}

/** Process-wide bus. */
export const ticketPhaseBus = new TicketPhaseBus();
