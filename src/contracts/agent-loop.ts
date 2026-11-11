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
  | "human_action"
  | "job_failed";

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
  job_failed: { jobId: string; kind: JobKind; error: string; stuck: boolean; willRetry: boolean };
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
  | "answer_resume"
  /** Pull requests: review a PR head read-only and submit structured findings (submit_review). */
  | "pr_review"
  /** Pull requests: apply selected findings of a review and push (same branch or a new stacked branch). */
  | "pr_fix";

/** Job kinds that work on a pull request (`job.subject.type === "pr"`) rather than a ticket. */
export const PR_JOB_KINDS: readonly JobKind[] = ["pr_review", "pr_fix"];

export function isPrJobKind(kind: JobKind): kind is "pr_review" | "pr_fix" {
  return kind === "pr_review" || kind === "pr_fix";
}

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
  /** epoch ms; a queued job is not dispatched before this (retry backoff). null/absent = now. */
  availableAt?: number | null;
  /** Per-run overrides captured at enqueue time (browser or integration). */
  runOptions?: JobRunOptions | null;
  /** Phase result reported when the job finished. */
  result?: PhaseResult | null;
  /**
   * What the job works on when it is not a ticket (pr_review / pr_fix).
   * Absent/null for ticket jobs. See jobSubjectKey() for the exclusivity key.
   */
  subject?: JobSubject | null;
  /** pr_review / pr_fix: the review document (`users/{uid}/prReviews/{reviewId}`) the job writes to or reads from. */
  reviewId?: string | null;
  /** pr_fix only: which findings to apply and where to push. */
  fix?: PrFixInput | null;
  /**
   * pr_fix only, server-written when the runner reports success: the branch it
   * pushed and the pushed commit (from `cli_phase_complete.gitContext`).
   */
  fixOutput?: PrFixOutput | null;
}

/** What a finished pr_fix pushed. */
export interface PrFixOutput {
  branch: string;
  headSha: string;
}

/** Per-run overrides captured at enqueue time. */
export interface JobRunOptions {
  cwd?: string;
  driverName?: string;
  model?: string;
  useWorktree?: boolean;
  /** Instruction contents (already resolved). Org instructions are added at dispatch. */
  systemInstructions?: string[];
  teamId?: string | null;
  /** Flaio PTY session id the browser referred to (legacy request_changes). */
  sessionId?: string;
  /** Plan iteration number for plan / revise_plan. */
  iteration?: number;
  /** Where the user wants the job to run. Absent = "auto" (local if eligible, else cloud). */
  runnerPreference?: RunnerPreference;
}

export const JOBS_COLLECTION = "jobs";

// ---- Pull request jobs (pr_review / pr_fix) -------------------------------

/** Runner choice for a job: a local CLI runner, the cloud runner, or whichever is eligible. */
export type RunnerPreference = "auto" | "local" | "cloud";

/** The pull request a pr_review / pr_fix job works on. */
export interface PrJobSubject {
  type: "pr";
  owner: string;
  repo: string;
  number: number;
  /** Commit the job reviews / fixes on top of. */
  headSha: string;
  headRef: string;
  baseRef: string;
  /** Head lives in a fork: reviews are read-only and fixes go to a new branch unless maintainers can edit. */
  isFork: boolean;
}

/** Non-ticket job subjects. Ticket jobs leave `subject` unset and use `ticketId`. */
export type JobSubject = PrJobSubject;

/** Where a pr_fix pushes: the PR's own head branch, or a new branch with a PR stacked on the original. */
export type PrFixTarget = "same_branch" | "new_branch";

export interface PrFixInput {
  /** Finding ids from the review named by `job.reviewId`. */
  findingIds: string[];
  target: PrFixTarget;
  /** new_branch only; the runner picks a name when absent. */
  newBranchName?: string;
  /**
   * The PR's head lives in a fork whose author allows edits by maintainers
   * (GitHub `maintainer_can_modify`), checked by the server against the live
   * PR. Only then may a `same_branch` fix push to a fork. Absent = false.
   */
  maintainerCanModify?: boolean;
  /** `owner/repo` of the PR's head repository when it is a fork (where a same-branch fix pushes). */
  headRepository?: string;
}

/** Exclusivity key of a pull request subject: `pr:<owner>/<repo>#<number>` (owner/repo lower-cased). */
export function prSubjectKey(pr: { owner: string; repo: string; number: number }): string {
  return `pr:${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}`;
}

/** Exclusivity key of a ticket: `ticket:<ticketId>`. */
export function ticketSubjectKey(ticketId: string): string {
  return `ticket:${ticketId}`;
}

/** At most one active job per subject key. Ticket jobs keep their per-ticket behaviour. */
export function jobSubjectKey(job: Pick<Job, "ticketId" | "subject">): string {
  return job.subject ? prSubjectKey(job.subject) : ticketSubjectKey(job.ticketId);
}

/** Verdict of an agent PR review. */
export type PrReviewVerdict = "approve" | "needs_fixes" | "comment";

export type PrFindingSeverity = "critical" | "high" | "medium" | "low" | "info";

/** How sure the reviewer is. "verified_by_test" = reproduced with a test or scratch run. */
export type PrFindingConfidence = "verified_by_test" | "high" | "medium" | "low";

/** A finding as the agent submits it (submit_review). The server adds id and state. */
export interface PrReviewFindingInput {
  severity: PrFindingSeverity;
  confidence: PrFindingConfidence;
  title: string;
  /** Repo-relative path, or null for a PR-wide finding. */
  path: string | null;
  /** Line in the head version of `path`, or null. */
  line: number | null;
  /** Concrete scenario that triggers the problem. */
  scenario: string;
  suggestedFix: string | null;
}

/** Structured result of a pr_review job (MCP submit_review → cli_phase_complete.review). */
export interface PrReviewSubmission {
  verdict: PrReviewVerdict;
  summary: string;
  findings: PrReviewFindingInput[];
  /** Things the reviewer checked and found clean, one sentence each. */
  checkedClean: string[];
}

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

/** Model providers a cloud runner can call with a provider key. */
export type ModelProviderName = "openrouter" | "anthropic" | "openai";

/**
 * Secrets a cloud runner fetches for one claimed job (relay_job_secrets).
 * Never persisted by the runner; expire with the job.
 */
export interface JobSecrets {
  provider: ModelProviderName;
  providerApiKey: string;
  /** Override for the provider's API base URL (e.g. OpenRouter). */
  providerBaseUrl?: string;
  model?: string;
  /** Short-lived GitHub App installation token scoped to the single repo of the job. */
  github: {
    token: string;
    /** "owner/repo" */
    repository: string;
    /** read: pr_review and every fork PR; write: pr_fix on same-repo PRs only. */
    access: "read" | "write";
    expiresAt: number;
  } | null;
  /** epoch ms; the runner must not use any secret after this. */
  expiresAt: number;
}

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

export type DecisionProviderName = "jev" | "llm" | "human" | "rule" | "chain";

export interface DecisionRequest<D extends DecisionId = DecisionId> {
  decision: D;
  ticketId: string;
  /** Plain-text context the provider scores against. Keep under ~30k tokens. */
  context: string;
  /** Minimum probability to accept without escalating. */
  threshold: number;
  /** Structured inputs (ticket, diff stats, touched paths, tool call, ...) for rule providers and context builders. */
  inputs?: object;
  /** Items to judge one by one (criteria_check: acceptance criteria). */
  items?: string[];
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

// ---- Agent assignment config (per integration) ----------------------------

/**
 * Optional fields on Jira / Linear / ClickUp integration configs that hand
 * issues to the Flaio agent. Off unless an admin enables it.
 */
export interface AgentAssignmentConfig {
  /** Master switch. When false/absent, assignee and label never create agent tickets. */
  agentAssignmentEnabled?: boolean;
  /** Provider user id of the Flaio agent identity (Jira accountId / Linear userId / ClickUp userId). */
  agentAssignee?: string;
  /** Label that hands an issue to the agent. Default "flaio" (only when enabled). */
  agentLabel?: string;
  /**
   * Who may resume the agent with comments (answers, new instructions).
   * "org_members" (default): only commenters mapped to members of the Flaio org.
   * "anyone": any commenter on the synced issue.
   */
  agentCommentTrust?: "org_members" | "anyone";
}
