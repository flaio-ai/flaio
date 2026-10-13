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

/** Tool name -> input/output schema. The MCP server registers exactly these. */
export const FLAIO_MCP_TOOLS = {
  get_ticket_context: { input: GetTicketContextInput, output: GetTicketContextOutput },
  submit_plan: { input: SubmitPlanInput, output: OkOutput },
  ask_question: { input: AskQuestionInput, output: AskQuestionOutput },
  record_decision: { input: RecordDecisionInput, output: OkOutput },
  report_progress: { input: ReportProgressInput, output: OkOutput },
  complete_phase: { input: CompletePhaseInput, output: OkOutput },
} as const;

export type FlaioMcpToolName = keyof typeof FLAIO_MCP_TOOLS;

/** Files kept in the ticket worktree (excluded from commits via .git/info/exclude). */
export const TICKET_WORKSPACE_DIR = ".flaio/ticket";
export const TICKET_WORKSPACE_FILES = {
  brief: "brief.md",
  plan: "plan.md",
  decisions: "decisions.md",
  progress: "progress.md",
  questions: "questions.md",
} as const;
