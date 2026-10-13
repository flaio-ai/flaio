import { describe, expect, it } from "vitest";
import { RelayToCliMsgSchema } from "../relay/relay-message-schemas.js";
import { CompletePhaseInput, FLAIO_MCP_TOOLS, SubmitPlanInput } from "./mcp-tools.js";
import { DECISIONS } from "./agent-loop.js";
import { TicketPhaseBus } from "./ticket-phase-bus.js";

const job = {
  id: "job1",
  ticketId: "t1",
  ownerUid: "u1",
  orgId: null,
  kind: "plan",
  prompt: null,
  permissionMode: "plan",
  status: "claimed",
  runnerId: "r1",
  leaseExpiresAt: 1,
  attempts: 1,
  maxAttempts: 3,
  error: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("Stage 0 contracts", () => {
  it("accepts relay_run_job with and without an agent session", () => {
    const base = {
      type: "relay_run_job",
      job,
      ticket: { id: "t1", title: "T", cwd: "~/repo", useWorktree: true, driverName: "claude", model: null, agentSession: null },
      briefMarkdown: "# T",
      systemInstructions: [],
    };
    expect(RelayToCliMsgSchema.safeParse(base).success).toBe(true);
    const resumed = { ...base, ticket: { ...base.ticket, agentSession: { id: "s", driver: "claude", resumeCount: 2 } } };
    expect(RelayToCliMsgSchema.safeParse(resumed).success).toBe(true);
  });

  it("rejects an unknown job kind", () => {
    const bad = { type: "relay_run_job", job: { ...job, kind: "deploy" }, ticket: {}, briefMarkdown: "", systemInstructions: [] };
    expect(RelayToCliMsgSchema.safeParse(bad).success).toBe(false);
  });

  it("defines the six MCP tools", () => {
    expect(Object.keys(FLAIO_MCP_TOOLS).sort()).toEqual(
      ["ask_question", "complete_phase", "get_ticket_context", "record_decision", "report_progress", "submit_plan"],
    );
    expect(SubmitPlanInput.safeParse({ steps: [], markdown: "x" }).success).toBe(false);
    expect(CompletePhaseInput.parse({ result: "success", summary: "done" }).testsRun).toEqual([]);
  });

  it("delivers typed events on the phase bus", () => {
    const bus = new TicketPhaseBus();
    let got = "";
    bus.onEvent("phase_complete", (p) => { got = p.completion.result; });
    bus.emitEvent("phase_complete", { ticketId: "t1", jobId: null, completion: { result: "needs_info", summary: "s", testsRun: [] } });
    expect(got).toBe("needs_info");
  });

  it("lists eight decisions", () => {
    expect(Object.keys(DECISIONS)).toHaveLength(8);
  });
});
