// ---------------------------------------------------------------------------
// Prompts for ticket job runs. The durable ticket context lives in
// .flaio/ticket/brief.md (written before every run); the prompt only says
// what this run is for.
// ---------------------------------------------------------------------------

import type { Job, JobKind } from "../../contracts/agent-loop.js";
import { TICKET_WORKSPACE_DIR, TICKET_WORKSPACE_FILES } from "../../contracts/mcp-tools.js";

export const BRIEF_RELATIVE_PATH = `${TICKET_WORKSPACE_DIR}/${TICKET_WORKSPACE_FILES.brief}`;

const KIND_INSTRUCTIONS: Record<JobKind, string> = {
  plan:
    "Analyze the ticket and produce a detailed implementation plan (files to create/modify, key steps, risks). Do not modify files in this phase.",
  revise_plan:
    "The plan was sent back for revision. Revise it to address the feedback below. Do not modify files in this phase.",
  implement:
    "The plan has been approved. Implement it, run the relevant tests, and commit your changes on the current branch.",
  review_fixes:
    "Review feedback arrived on your changes. Address every point below, run the relevant tests, and commit the fixes.",
  ci_fix:
    "A CI check failed on the ticket branch. Find the cause using the log below, fix it, run the relevant tests, and commit the fix.",
  answer_resume:
    "A question you asked has been answered (see below and the brief). Continue the phase you were in.",
};

const PLAN_KINDS: ReadonlySet<JobKind> = new Set(["plan", "revise_plan"]);

export function isPlanKind(kind: JobKind): boolean {
  return PLAN_KINDS.has(kind);
}

export interface JobPromptOptions {
  ticketId: string;
  ticketTitle: string;
  /** The run resumes the ticket's existing agent session. */
  resumed: boolean;
  /** A previous session existed but could not be resumed (fresh session + brief). */
  freshAfterPrevious: boolean;
  /** Flaio MCP tools are attached. */
  hasMcp: boolean;
  branchName: string | null;
}

/** Prompt for a dispatched job (relay_run_job). */
export function buildJobPrompt(job: Pick<Job, "kind" | "prompt">, opts: JobPromptOptions): string {
  const parts: string[] = [];
  if (opts.resumed) {
    parts.push(
      `New job for ticket ${opts.ticketId}: ${job.kind}.`,
      `The ticket brief at ${BRIEF_RELATIVE_PATH} has been updated — re-read it before continuing.`,
    );
  } else {
    parts.push(
      `You are working on ticket ${opts.ticketId}: ${opts.ticketTitle}`,
      `Read the ticket brief at ${BRIEF_RELATIVE_PATH} first. It holds the ticket, acceptance criteria, decisions so far and the latest handoff notes.`,
    );
    if (opts.freshAfterPrevious) {
      parts.push("Earlier work on this ticket happened in another session; rely on the brief and the git history of this branch for that context.");
    }
  }
  parts.push("", `Job: ${job.kind}`, KIND_INSTRUCTIONS[job.kind]);

  if (job.prompt?.trim()) {
    parts.push("", "Instructions for this run:", job.prompt.trim());
  }

  if (opts.branchName && !isPlanKind(job.kind)) {
    parts.push("", `You are on the dedicated branch ${opts.branchName}; commit there.`);
  }

  if (opts.hasMcp) {
    parts.push("");
    if (isPlanKind(job.kind)) {
      parts.push("Submit the plan with the flaio `submit_plan` tool.");
    }
    parts.push(
      "Use `ask_question` if you are blocked on missing information, `record_decision` for notable choices and `report_progress` as you complete steps.",
      "When the phase is finished, call `complete_phase` with the result and a short summary. This is how Flaio knows you are done.",
    );
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Legacy (relay_start_* / relay_request_changes) prompts and briefs
// ---------------------------------------------------------------------------

export interface LegacyBriefInput {
  ticketId: string;
  title: string;
  description?: string;
  plan?: string;
  previousPlan?: string;
  feedback?: string;
}

/** Brief for legacy-initiated runs (no context assembler on the server yet). */
export function buildLegacyBrief(input: LegacyBriefInput): string {
  const parts = [`# ${input.title || `Ticket ${input.ticketId}`}`, "", `Ticket id: ${input.ticketId}`];
  if (input.description?.trim()) parts.push("", "## Description", "", input.description.trim());
  if (input.plan?.trim()) parts.push("", "## Approved plan", "", input.plan.trim());
  else if (input.previousPlan?.trim()) parts.push("", "## Previous plan", "", input.previousPlan.trim());
  if (input.feedback?.trim()) parts.push("", "## Latest feedback", "", input.feedback.trim());
  return parts.join("\n") + "\n";
}

/** Print-mode planning prompt (stdout is captured as the plan when no MCP plan arrives). */
export function buildLegacyPlanningPrompt(input: {
  title: string;
  description: string;
  previousPlan?: string;
  feedback?: string;
  resumed: boolean;
}): string {
  const parts: string[] = [];
  if (input.resumed && input.feedback) {
    parts.push(
      "The user requested revisions to your plan.",
      "",
      "User Feedback:",
      input.feedback,
      "",
      "Revise the plan based on the feedback above.",
    );
  } else {
    parts.push(
      "You are planning the implementation of a ticket.",
      "",
      `Title: ${input.title}`,
      `Description: ${input.description}`,
      `(The same is in ${BRIEF_RELATIVE_PATH}.)`,
      "",
    );
    if (input.previousPlan && input.feedback) {
      parts.push(
        "A previous plan was created but the user requested revisions.",
        "",
        "Previous Plan:",
        input.previousPlan,
        "",
        "User Feedback:",
        input.feedback,
        "",
        "Revise the plan based on the feedback above.",
      );
    } else {
      parts.push("Analyze the requirements and create a detailed implementation plan.");
    }
  }
  parts.push(
    "",
    "The plan must include:",
    "- Files to create/modify",
    "- Key implementation steps with code snippets where helpful",
    "- Any potential issues or considerations",
    "",
    "IMPORTANT: Output ONLY the complete plan. Do NOT add a summary, introduction, or conclusion.",
    "Your entire output will be captured and shown to the user as the plan.",
  );
  return parts.join("\n");
}

export function buildLegacyInteractivePlanningPrompt(input: { title: string; description: string }): string {
  return [
    "You are planning the implementation of a ticket.",
    "",
    `Title: ${input.title}`,
    `Description: ${input.description}`,
    `(The same is in ${BRIEF_RELATIVE_PATH}.)`,
    "",
    "Please analyze the requirements and create a detailed implementation plan. Include:",
    "- Files to create/modify",
    "- Key implementation steps",
    "- Any potential issues or considerations",
  ].join("\n");
}

export function buildLegacyImplementationPrompt(input: {
  plan: string;
  branchName: string | null;
  resumed: boolean;
}): string {
  const parts = input.resumed
    ? ["The plan has been approved. Implement it now. Follow the plan exactly.", "", "Approved plan:", input.plan]
    : ["You are implementing a plan. Follow the plan exactly.", "", "Plan:", input.plan];
  if (input.branchName) {
    parts.push(
      "",
      `You are working on a dedicated git worktree branch: ${input.branchName}`,
      "All your changes are already isolated on this branch. Commit your changes when done.",
    );
  } else {
    parts.push("", "Implement the plan step by step. When done, create a git branch and commit your changes.");
  }
  return parts.join("\n");
}

export function buildLegacyChangesPrompt(feedback: string, phase: "planning" | "implementation"): string {
  return phase === "planning"
    ? ["The user requested changes to your plan.", "", "Feedback:", feedback, "", "Revise the plan accordingly."].join("\n")
    : ["The user requested changes to your implementation.", "", "Feedback:", feedback, "", "Address the feedback and commit the changes."].join("\n");
}
