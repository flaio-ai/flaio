import { describe, expect, it } from "vitest";
import { RelayToCliMsgSchema } from "../relay/relay-message-schemas.js";
import {
  CompletePhaseInput,
  FLAIO_MCP_PR_TOOLS,
  FLAIO_MCP_TOOLS,
  FLAIO_MCP_TOOLSETS,
  SubmitPlanInput,
  SubmitReviewInput,
  toolsetAllows,
} from "./mcp-tools.js";
import { DECISIONS, jobSubjectKey, type PrReviewSubmission } from "./agent-loop.js";
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

  it("keeps the PR fix input fields (the parsed message is what the runner uses)", () => {
    const fix = { findingIds: ["f1"], target: "same_branch", maintainerCanModify: true, headRepository: "contrib/widgets" };
    const subject = { type: "pr", owner: "acme", repo: "widgets", number: 7, headSha: "a".repeat(40), headRef: "feature", baseRef: "main", isFork: true };
    const msg = {
      type: "relay_run_job",
      job: { ...job, kind: "pr_fix", permissionMode: "acceptEdits", subject, reviewId: "rev1", fix },
      ticket: { id: "rev1", title: "T", cwd: "", useWorktree: true, driverName: "claude", model: null, agentSession: null },
      briefMarkdown: "# T",
      systemInstructions: [],
    };
    const parsed = RelayToCliMsgSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.type === "relay_run_job" && parsed.data.job.fix).toEqual(fix);
  });

  it("rejects an unknown job kind", () => {
    const bad = { type: "relay_run_job", job: { ...job, kind: "deploy" }, ticket: {}, briefMarkdown: "", systemInstructions: [] };
    expect(RelayToCliMsgSchema.safeParse(bad).success).toBe(false);
  });

  it("defines the MCP tools: the six ticket tools plus submit_review", () => {
    expect(Object.keys(FLAIO_MCP_TOOLS).sort()).toEqual(
      ["ask_question", "complete_phase", "get_ticket_context", "record_decision", "report_progress", "submit_plan", "submit_review"],
    );
    expect([...FLAIO_MCP_TOOLSETS.ticket].sort()).toEqual(
      ["ask_question", "complete_phase", "get_ticket_context", "record_decision", "report_progress", "submit_plan"],
    );
    expect(toolsetAllows(undefined, "submit_review")).toBe(false);
    expect(toolsetAllows("pr_review", "submit_review")).toBe(true);
    expect(toolsetAllows("pr_review", "submit_plan")).toBe(false);
    expect(toolsetAllows("pr_fix", "complete_phase")).toBe(true);
    expect(toolsetAllows("pr_fix", "submit_review")).toBe(false);
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

  it("accepts pr_review jobs with a PR subject (Pull requests Wave 0)", () => {
    const subject = {
      type: "pr",
      owner: "flaio-ai",
      repo: "flaio-app",
      number: 108,
      headSha: "60a1410",
      headRef: "vd/stage2-integration",
      baseRef: "virtual-dev",
      isFork: false,
    } as const;
    const msg = {
      type: "relay_run_job",
      job: { ...job, kind: "pr_review", permissionMode: "plan", subject, reviewId: "rev1" },
      ticket: { id: "t1", title: "T", cwd: "~/repo", useWorktree: true, driverName: "claude", model: null, agentSession: null },
      briefMarkdown: "",
      systemInstructions: [],
    };
    expect(RelayToCliMsgSchema.safeParse(msg).success).toBe(true);
    expect(jobSubjectKey({ ticketId: "t1", subject })).toBe("pr:flaio-ai/flaio-app#108");
    expect(jobSubjectKey({ ticketId: "t1" })).toBe("ticket:t1");
  });

  it("defines submit_review matching PrReviewSubmission, registered for PR review sessions", () => {
    expect(Object.keys(FLAIO_MCP_PR_TOOLS)).toEqual(["submit_review"]);
    expect(FLAIO_MCP_TOOLS.submit_review.input).toBe(SubmitReviewInput);
    const parsed: PrReviewSubmission = SubmitReviewInput.parse({
      verdict: "needs_fixes",
      summary: "Two lifecycle bugs.",
      findings: [{ severity: "high", confidence: "verified_by_test", title: "Orphaned job", scenario: "Restart the CLI.", path: "a.ts", line: 3 }],
    });
    expect(parsed.findings[0].suggestedFix).toBeNull();
    expect(parsed.checkedClean).toEqual([]);
    expect(SubmitReviewInput.safeParse({ verdict: "lgtm", summary: "x" }).success).toBe(false);
  });

  it("lists eight decisions", () => {
    expect(Object.keys(DECISIONS)).toHaveLength(8);
  });
});
