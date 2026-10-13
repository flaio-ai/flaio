// ---------------------------------------------------------------------------
// Legacy → job mapping
//
// The current web app still sends relay_start_planning /
// relay_start_interactive_planning / relay_start_implementation /
// relay_request_changes. These pure functions turn them into a RelayRunJobMsg
// plus legacy run options, so every ticket run goes through JobRunner.runJob
// and reuses the ticket's agent session (planning → implementation resumes the
// SAME session id).
// ---------------------------------------------------------------------------

import type { AgentPermissionMode, Job, JobKind, TicketAgentSession } from "../../contracts/agent-loop.js";
import {
  DEFAULT_DRIVER_NAME,
  type RelayRequestChangesMsg,
  type RelayRunJobMsg,
  type RelayStartImplementationMsg,
  type RelayStartInteractivePlanningMsg,
  type RelayStartPlanningMsg,
} from "../relay-protocol.js";
import type { TrackedTicket } from "../ticket-tracker.js";
import {
  buildLegacyBrief,
  buildLegacyChangesPrompt,
  buildLegacyImplementationPrompt,
  buildLegacyInteractivePlanningPrompt,
  buildLegacyPlanningPrompt,
  isPlanKind,
} from "./job-prompts.js";

/** Which legacy flow a run belongs to — decides the legacy outbound messages. */
export type LegacyMode = "planning_print" | "planning_interactive" | "implementation";

export interface LegacyRunContext {
  mode: LegacyMode;
  /** Plan iteration reported in cli_plan_ready. */
  iteration: number;
  feedback: string | null;
}

export interface RunJobOptions {
  /** Present for runs started by a legacy message: emit legacy outbound messages, not job messages. */
  legacy?: LegacyRunContext;
  /** Replace the default job prompt (legacy flows keep their wording). */
  buildPrompt?: (ctx: { resumed: boolean; branchName: string | null; hasMcp: boolean }) => string;
  /** Non-interactive print mode (process exits when done; stdout captured). */
  print?: boolean;
  allowedTools?: string[];
  /** "append": add briefMarkdown to the existing brief instead of replacing it. */
  briefMode?: "replace" | "append";
}

export interface MappedLegacyRun {
  msg: RelayRunJobMsg;
  options: RunJobOptions;
}

/** Read-only tools for print-mode planning (unchanged from the pre-job implementation). */
export const LEGACY_PLANNING_TOOLS = ["Read", "Glob", "Grep", "Bash(git *)"];

export const LEGACY_JOB_PREFIX = "legacy-";

export function isLegacyJobId(jobId: string | null | undefined): boolean {
  return !!jobId && jobId.startsWith(LEGACY_JOB_PREFIX);
}

/** Job kinds that resume the ticket's agent session (CONTRACTS.md table). */
export const RESUME_KINDS: ReadonlySet<JobKind> = new Set([
  "revise_plan",
  "implement",
  "review_fixes",
  "ci_fix",
  "answer_resume",
]);

export function synthesizeLegacyJob(
  ticketId: string,
  kind: JobKind,
  permissionMode: AgentPermissionMode,
  prompt: string | null,
  now: number,
): Job {
  return {
    id: `${LEGACY_JOB_PREFIX}${kind}-${ticketId}-${now.toString(36)}`,
    ticketId,
    ownerUid: "",
    orgId: null,
    kind,
    prompt,
    permissionMode,
    status: "claimed",
    runnerId: null,
    leaseExpiresAt: null,
    attempts: 1,
    maxAttempts: 1,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

function resumable(kind: JobKind, entry: TrackedTicket | undefined): TicketAgentSession | null {
  return RESUME_KINDS.has(kind) ? (entry?.agentSession ?? null) : null;
}

/**
 * relay_start_planning → plan (or revise_plan when feedback on a previous plan
 * is given). Runs in print mode so stdout capture still works as the fallback
 * plan; permission mode stays "default" + read-only allow-list because
 * `claude -p --permission-mode plan` ends on ExitPlanMode rather than printing
 * the plan.
 */
export function mapStartPlanning(
  msg: RelayStartPlanningMsg,
  entry: TrackedTicket | undefined,
  systemInstructions: string[],
  now: number,
): MappedLegacyRun {
  const isRevision = !!(msg.previousPlan && msg.feedback);
  const kind: JobKind = isRevision ? "revise_plan" : "plan";
  const job = synthesizeLegacyJob(msg.ticketId, kind, "default", msg.feedback ?? null, now);
  return {
    msg: {
      type: "relay_run_job",
      job,
      ticket: {
        id: msg.ticketId,
        title: msg.ticketTitle,
        cwd: msg.cwd,
        useWorktree: !!msg.useWorktree,
        driverName: msg.driverName || DEFAULT_DRIVER_NAME,
        model: msg.model ?? null,
        agentSession: resumable(kind, entry),
      },
      briefMarkdown: buildLegacyBrief({
        ticketId: msg.ticketId,
        title: msg.ticketTitle,
        description: msg.ticketDescription,
        previousPlan: msg.previousPlan,
        feedback: msg.feedback,
      }),
      systemInstructions,
    },
    options: {
      legacy: { mode: "planning_print", iteration: msg.iteration ?? 0, feedback: msg.feedback ?? null },
      print: true,
      allowedTools: LEGACY_PLANNING_TOOLS,
      buildPrompt: ({ resumed }) =>
        buildLegacyPlanningPrompt({
          title: msg.ticketTitle,
          description: msg.ticketDescription,
          previousPlan: msg.previousPlan,
          feedback: msg.feedback,
          resumed,
        }),
    },
  };
}

/** relay_start_interactive_planning → plan job in plan permission mode (interactive TUI). */
export function mapStartInteractivePlanning(
  msg: RelayStartInteractivePlanningMsg,
  _entry: TrackedTicket | undefined,
  systemInstructions: string[],
  now: number,
): MappedLegacyRun {
  const job = synthesizeLegacyJob(msg.ticketId, "plan", "plan", null, now);
  return {
    msg: {
      type: "relay_run_job",
      job,
      ticket: {
        id: msg.ticketId,
        title: msg.ticketTitle,
        cwd: msg.cwd,
        useWorktree: !!msg.useWorktree,
        driverName: msg.driverName || DEFAULT_DRIVER_NAME,
        model: msg.model ?? null,
        agentSession: null,
      },
      briefMarkdown: buildLegacyBrief({
        ticketId: msg.ticketId,
        title: msg.ticketTitle,
        description: msg.ticketDescription,
      }),
      systemInstructions,
    },
    options: {
      legacy: { mode: "planning_interactive", iteration: 0, feedback: null },
      buildPrompt: () =>
        buildLegacyInteractivePlanningPrompt({ title: msg.ticketTitle, description: msg.ticketDescription }),
    },
  };
}

/** relay_start_implementation → implement job resuming the planning session (acceptEdits). */
export function mapStartImplementation(
  msg: RelayStartImplementationMsg,
  entry: TrackedTicket | undefined,
  systemInstructions: string[],
  now: number,
): MappedLegacyRun {
  const job = synthesizeLegacyJob(msg.ticketId, "implement", "acceptEdits", null, now);
  return {
    msg: {
      type: "relay_run_job",
      job,
      ticket: {
        id: msg.ticketId,
        title: entry?.ticketTitle ?? "",
        cwd: msg.cwd,
        useWorktree: !!msg.useWorktree,
        driverName: msg.driverName || entry?.driverName || DEFAULT_DRIVER_NAME,
        model: msg.model ?? entry?.model ?? null,
        agentSession: resumable("implement", entry),
      },
      briefMarkdown: buildLegacyBrief({
        ticketId: msg.ticketId,
        title: entry?.ticketTitle ?? "",
        plan: msg.plan,
      }),
      systemInstructions,
    },
    options: {
      legacy: { mode: "implementation", iteration: 0, feedback: null },
      buildPrompt: ({ resumed, branchName }) =>
        buildLegacyImplementationPrompt({ plan: msg.plan, branchName, resumed }),
    },
  };
}

/**
 * relay_request_changes when the PTY is gone → resume the ticket's session
 * with the feedback: revise_plan after a planning phase, review_fixes
 * otherwise. Returns null when nothing is known about the ticket locally.
 */
export function mapRequestChanges(
  msg: RelayRequestChangesMsg,
  entry: TrackedTicket | undefined,
  now: number,
): MappedLegacyRun | null {
  if (!entry || !entry.originalCwd) return null;
  const planning = entry.lastJobKind
    ? isPlanKind(entry.lastJobKind)
    : entry.status === "planning" || entry.status === "plan_ready";
  const kind: JobKind = planning ? "revise_plan" : "review_fixes";
  const permissionMode: AgentPermissionMode = planning ? "plan" : "acceptEdits";
  const job = synthesizeLegacyJob(msg.ticketId, kind, permissionMode, msg.feedback, now);
  return {
    msg: {
      type: "relay_run_job",
      job,
      ticket: {
        id: msg.ticketId,
        title: entry.ticketTitle,
        cwd: entry.originalCwd,
        useWorktree: entry.useWorktree ?? !!entry.worktreePath,
        driverName: entry.driverName || DEFAULT_DRIVER_NAME,
        model: entry.model ?? null,
        agentSession: entry.agentSession ?? null,
      },
      briefMarkdown: `## Change request\n\n${msg.feedback.trim()}\n`,
      systemInstructions: [],
    },
    options: {
      briefMode: "append",
      legacy: {
        mode: planning ? "planning_interactive" : "implementation",
        iteration: entry.planIterations ?? 0,
        feedback: msg.feedback,
      },
      buildPrompt: () => buildLegacyChangesPrompt(msg.feedback, planning ? "planning" : "implementation"),
    },
  };
}
