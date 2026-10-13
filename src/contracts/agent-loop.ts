// MIRROR of flaio-app packages/shared/src/agent-loop.ts — keep the two in sync.
// ---------------------------------------------------------------------------
// Virtual developer contracts (Stage 0)
//
// Shared types for ticket continuity, the event log, the job queue, runners
// and the decision layer. See docs/virtual-dev/CONTRACTS.md.
// Additive only: nothing here changes existing ticket or protocol behaviour.
// ---------------------------------------------------------------------------

// ---- Ticket continuity ----------------------------------------------------

/** Agent permission mode a job runs in. Maps to the driver's own flags. */
export type AgentPermissionMode = "plan" | "acceptEdits" | "default";

/**
 * The agent's own resumable session for a ticket. One per ticket (lead agent);
 * every phase resumes it instead of starting fresh.
 */
export interface TicketAgentSession {
  /** The agent CLI's session id (e.g. Claude Code session UUID). */
  id: string;
  /** Driver name, e.g. "claude", "codex", "gemini". */
  driver: string;
  /** Local path of the agent transcript on the runner, if known. */
  transcriptPath?: string;
  /** Runner that owns the session (transcripts live on that machine). */
  runnerId?: string;
  /** How many times the session has been resumed. */
  resumeCount: number;
  lastResumedAt?: number;
}

/**
 * Lifecycle state alongside the kanban column. `column` stays the board
 * position; `state` says what the agent is doing right now.
 */
export type TicketAgentState =
  | "idle"
  | "queued"
  | "running"
  | "needs_info"
  | "blocked"
  | "stuck"
  | "failed";

// ---- Ticket event log -----------------------------------------------------

export type TicketEventKind =
  | "phase_changed"
  | "plan_submitted"
  | "question_asked"
  | "question_answered"
  | "decision_recorded"
  | "progress_reported"
  | "phase_completed"
  | "external_comment"
  | "pr_review_comment"
  | "ci_failed"
  | "jev_decision"
  | "human_action";

export type TicketEventActorType = "agent" | "user" | "system" | "integration";

export interface TicketEventActor {
  type: TicketEventActorType;
  /** uid, agent session id, integration name or "system". */
  id: string;
  displayName?: string;
}

export interface TicketEventPayloads {
  phase_changed: { from: string; to: string; reason?: string };
  plan_submitted: { steps: string[]; risks: string[]; files: string[]; markdown: string; iteration: number };
  question_asked: { questionId: string; text: string; blocking: boolean };
  question_answered: { questionId: string; text: string };
  decision_recorded: { title: string; rationale: string };
  progress_reported: { step: string; status: "started" | "done" | "skipped" | "failed"; note?: string };
  phase_completed: {
    phase: JobKind;
    result: PhaseResult;
    summary: string;
    testsRun?: string[];
  };
  external_comment: {
    provider: string;
    externalCommentId: string;
    author: string;
    body: string;
    url?: string;
  };
  pr_review_comment: { prUrl: string; author: string; body: string; path?: string; line?: number; url?: string };
  ci_failed: { checkName: string; url?: string; logExcerpt: string };
  jev_decision: DecisionLogEntry;
  human_action: { action: "approve_plan" | "request_changes" | "reset" | "assign_agent" | "unassign_agent" | "answer"; note?: string };
}

export interface TicketEvent<K extends TicketEventKind = TicketEventKind> {
  id: string;
  ticketId: string;
  kind: K;
  /** epoch ms */
  at: number;
  actor: TicketEventActor;
  payload: TicketEventPayloads[K];
}

/** Firestore path helpers. Events live under the ticket document. */
export const ticketEventsPath = (uid: string, ticketId: string) =>
  `users/${uid}/tickets/${ticketId}/events`;

// ---- Jobs -----------------------------------------------------------------

export type JobKind =
  | "plan"
  | "implement"
  | "revise_plan"
  | "review_fixes"
  | "ci_fix"
  | "answer_resume";

export type JobStatus = "queued" | "claimed" | "running" | "done" | "failed" | "cancelled";

export type PhaseResult = "success" | "needs_info" | "failed";

export interface Job {
  id: string;
  ticketId: string;
  ownerUid: string;
  orgId: string | null;
  kind: JobKind;
  /** Extra instruction for this run (feedback, answer, CI log). The brief is built at dispatch. */
  prompt: string | null;
  permissionMode: AgentPermissionMode;
  status: JobStatus;
  runnerId: string | null;
  /** epoch ms; a claimed job whose lease expires goes back to queued. */
  leaseExpiresAt: number | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export const JOBS_COLLECTION = "jobs";

// ---- Runners --------------------------------------------------------------

export type RunnerKind = "local" | "self_hosted" | "cloud";

export interface Runner {
  id: string;
  ownerUid: string;
  orgId: string | null;
  kind: RunnerKind;
  hostname: string;
  /** Installed agent drivers, e.g. ["claude", "codex"]. */
  drivers: string[];
  /** Repo remote URLs (normalized) this runner can work in. */
  repos: string[];
  maxConcurrent: number;
  activeJobs: number;
  online: boolean;
  lastHeartbeatAt: number;
  cliVersion: string;
}

export const RUNNERS_COLLECTION = "runners";

// ---- Decision layer (Jev + fallbacks) ------------------------------------

export const DECISIONS = {
  intake_triage: ["ready", "needs_info", "not_for_agent"],
  complexity_routing: ["single_agent", "lead_with_workers", "human_only"],
  runner_pick: ["haiku", "sonnet", "opus", "codex", "gemini"],
  autonomy_gate: ["auto_approve", "needs_review"],
  tool_approval: ["allow", "deny", "ask_human"],
  comment_intent: ["answer", "new_requirement", "approval", "change_request", "noise"],
  stuck_check: ["progressing", "looping", "blocked", "failed"],
  criteria_check: ["met", "not_met", "unclear"],
} as const;

export type DecisionId = keyof typeof DECISIONS;
export type DecisionAnswer<D extends DecisionId> = (typeof DECISIONS)[D][number];

export type DecisionProviderName = "jev" | "llm" | "human" | "rule";

export interface DecisionRequest<D extends DecisionId = DecisionId> {
  decision: D;
  ticketId: string;
  /** Plain-text context the provider scores against. Keep under ~30k tokens. */
  context: string;
  /** Minimum probability to accept without escalating. */
  threshold: number;
}

export interface DecisionResult<D extends DecisionId = DecisionId> {
  decision: D;
  answer: DecisionAnswer<D>;
  /** 0..1 */
  probability: number;
  provider: DecisionProviderName;
  /** True when a lower tier was below threshold or failed. */
  escalated: boolean;
  /** Present for criteria_check: one answer per acceptance criterion. */
  perItem?: { item: string; answer: DecisionAnswer<D>; probability: number }[];
}

export interface DecisionProvider {
  readonly name: DecisionProviderName;
  decide<D extends DecisionId>(req: DecisionRequest<D>): Promise<DecisionResult<D>>;
}

export interface DecisionLogEntry {
  decision: DecisionId;
  answer: string;
  probability: number;
  provider: DecisionProviderName;
  escalated: boolean;
  threshold: number;
}
