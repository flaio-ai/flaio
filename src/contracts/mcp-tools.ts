// ---------------------------------------------------------------------------
// Flaio MCP tool contracts (Stage 0)
//
// Tools the agent calls instead of Flaio scraping the terminal. Implemented by
// the Flaio MCP server (src/mcp, WS-A2); results flow to the CLI over the
// TicketPhaseBus (src/contracts/ticket-phase-bus.ts) and on to the relay as
// cli_ticket_event / cli_phase_complete.
// ---------------------------------------------------------------------------

import { z } from "zod";

export const FLAIO_MCP_SERVER_NAME = "flaio";

export const GetTicketContextInput = z.object({});
export const GetTicketContextOutput = z.object({
  ticketId: z.string(),
  briefMarkdown: z.string(),
  planMarkdown: z.string().nullable(),
  decisionsMarkdown: z.string().nullable(),
  progressMarkdown: z.string().nullable(),
  openQuestions: z.array(z.object({ questionId: z.string(), text: z.string() })),
});

export const SubmitPlanInput = z.object({
  steps: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  /** Full plan as markdown, written to .flaio/ticket/plan.md and shown to reviewers. */
  markdown: z.string().min(1),
});

export const AskQuestionInput = z.object({
  text: z.string().min(1),
  /** true = park the ticket in needs_info and end the phase after asking. */
  blocking: z.boolean().default(true),
});
export const AskQuestionOutput = z.object({ questionId: z.string() });

export const RecordDecisionInput = z.object({
  title: z.string().min(1),
  rationale: z.string().min(1),
});

export const ReportProgressInput = z.object({
  step: z.string().min(1),
  status: z.enum(["started", "done", "skipped", "failed"]),
  note: z.string().optional(),
});

export const CompletePhaseInput = z.object({
  result: z.enum(["success", "needs_info", "failed"]),
  summary: z.string().min(1),
  testsRun: z.array(z.string()).default([]),
});

export const OkOutput = z.object({ ok: z.literal(true) });

// ---- Pull request review tools ---------------------------------------------
//
// submit_review gives a pr_review job structured output, the way submit_plan
// does for tickets: hook server -> TicketPhaseBus (review_submitted) ->
// cli_phase_complete.review. Mirrors PrReviewSubmission in ./agent-loop.ts.

export const PrReviewFindingInputSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  /** "verified_by_test" only when reproduced with a test or scratch run. */
  confidence: z.enum(["verified_by_test", "high", "medium", "low"]),
  title: z.string().min(1),
  /** Repo-relative path; null for a PR-wide finding. */
  path: z.string().min(1).nullable().default(null),
  /** Line in the head version of `path`. */
  line: z.number().int().positive().nullable().default(null),
  /** Concrete scenario that triggers the problem. */
  scenario: z.string().min(1),
  suggestedFix: z.string().min(1).nullable().default(null),
});

export const SubmitReviewInput = z.object({
  verdict: z.enum(["approve", "needs_fixes", "comment"]),
  summary: z.string().min(1),
  findings: z.array(PrReviewFindingInputSchema).default([]),
  /** Things checked and found clean, one sentence each. */
  checkedClean: z.array(z.string().min(1)).default([]),
});

/** Tool name -> input/output schema. The MCP server registers these (filtered by toolset). */
export const FLAIO_MCP_TOOLS = {
  get_ticket_context: { input: GetTicketContextInput, output: GetTicketContextOutput },
  submit_plan: { input: SubmitPlanInput, output: OkOutput },
  ask_question: { input: AskQuestionInput, output: AskQuestionOutput },
  record_decision: { input: RecordDecisionInput, output: OkOutput },
  report_progress: { input: ReportProgressInput, output: OkOutput },
  complete_phase: { input: CompletePhaseInput, output: OkOutput },
  submit_review: { input: SubmitReviewInput, output: OkOutput },
} as const;

export type FlaioMcpToolName = keyof typeof FLAIO_MCP_TOOLS;

/** @deprecated submit_review is registered in FLAIO_MCP_TOOLS; kept for imports of the Wave 0 name. */
export const FLAIO_MCP_PR_TOOLS = {
  submit_review: FLAIO_MCP_TOOLS.submit_review,
} as const;

export type FlaioMcpPrToolName = keyof typeof FLAIO_MCP_PR_TOOLS;

/**
 * Which tools an agent session may see and call. Ticket jobs keep the ticket
 * tools; a pr_review agent can only read its brief, report progress and submit
 * one review; a pr_fix agent reports progress and completes the phase (the CLI
 * commits and pushes afterwards).
 */
export type FlaioMcpToolset = "ticket" | "pr_review" | "pr_fix";

export const FLAIO_MCP_TOOLSETS: Record<FlaioMcpToolset, readonly FlaioMcpToolName[]> = {
  ticket: ["get_ticket_context", "submit_plan", "ask_question", "record_decision", "report_progress", "complete_phase"],
  pr_review: ["get_ticket_context", "report_progress", "submit_review"],
  pr_fix: ["get_ticket_context", "report_progress", "complete_phase"],
};

export function isFlaioMcpToolset(value: unknown): value is FlaioMcpToolset {
  return value === "ticket" || value === "pr_review" || value === "pr_fix";
}

/** True when `tool` belongs to `toolset` (no toolset = the ticket tools, the pre-PR behaviour). */
export function toolsetAllows(toolset: FlaioMcpToolset | null | undefined, tool: FlaioMcpToolName): boolean {
  return FLAIO_MCP_TOOLSETS[toolset ?? "ticket"].includes(tool);
}

/** Files kept in the ticket worktree (excluded from commits via .git/info/exclude). */
export const TICKET_WORKSPACE_DIR = ".flaio/ticket";
export const TICKET_WORKSPACE_FILES = {
  brief: "brief.md",
  plan: "plan.md",
  decisions: "decisions.md",
  progress: "progress.md",
  questions: "questions.md",
} as const;

/** Extra workspace files of pull request jobs (next to brief.md). */
export const PR_WORKSPACE_FILES = {
  /** `git diff <base>...<head>` of the PR, size-capped. */
  diff: "pr.diff",
  /** The review the agent submitted (submit_review), as JSON. */
  review: "review.json",
} as const;
