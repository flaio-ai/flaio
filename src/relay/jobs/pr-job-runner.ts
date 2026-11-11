// ---------------------------------------------------------------------------
// PrJobRunner — pr_review / pr_fix jobs on a local runner (Pull requests, F)
//
// relay_run_job with job.subject.type === "pr" (routed here by JobRunner):
//   resolve the local clone of subject.owner/repo (tracked project dirs)
//   → fetch pull/<n>/head into a detached worktree, verify headSha
//   → write .flaio/ticket/brief.md (+ pr.diff)
//   → start the agent headless (print mode) in an untrusted-workspace posture
//     with a PR toolset on the Flaio MCP server
//   pr_review: submit_review → cli_phase_complete { review }
//   pr_fix:    complete_phase + agent exit → commit, push (never force)
//              → cli_phase_complete { gitContext: { branch, headSha } }
//   → remove the worktree on every exit path.
//
// Runs are keyed by the review id (relay_run_job.ticket.id === job.ticketId
// === job.reviewId). Nothing is written to the TicketTracker: PR jobs leave no
// tickets.json entries, ticket cleanup never sees them, and they never resume
// an agent session.
// ---------------------------------------------------------------------------

import { jobSubjectKey, type Job, type PrFixInput, type PrJobSubject } from "../../contracts/agent-loop.js";
import type { TicketPhaseBusEvents } from "../../contracts/ticket-phase-bus.js";
import type { AgentStatus, BaseDriver } from "../../agents/drivers/base-driver.js";
import { stripAnsi } from "../../strip-ansi.js";
import { makeDebugLog } from "../../connectors/debug.js";
import { DEFAULT_DRIVER_NAME, type CliToRelayMsg, type RelayCancelJobMsg, type RelayRunJobMsg } from "../relay-protocol.js";
import {
  assertRemoteBranchAbsent,
  checkFixTarget,
  checkoutPr,
  cleanupPrCheckout,
  finishPrFix,
  fixTargetBranch,
  formatFixChanges,
  PrJobError,
  resolvePrRepo,
  validatePrSubject,
  writePrDiff,
  type PrCheckout,
  type PrFixResult,
  type PrRepoMatch,
} from "../pr-checkout.js";
import type { McpSpawnConfig, McpSpawnConfigProvider, TicketWorkspaceWriter } from "./job-seams.js";
import { buildPrFixPrompt, buildPrReviewPrompt, prAgentPermissionMode, prAgentPermissions } from "./pr-job-prompts.js";
import type { JobAgentSession } from "./job-runner.js";
import { isSafeAgentArg } from "../../agents/drivers/base-driver.js";

const debugLog = makeDebugLog("pr-jobs");

type PrJobKind = "pr_review" | "pr_fix";
type JobEndMsg = Extract<CliToRelayMsg, { type: "cli_phase_complete" | "cli_job_failed" }>;
type SubmittedReview = TicketPhaseBusEvents["review_submitted"]["review"];

/** Git/filesystem side of a PR job (real implementations in ../pr-checkout.ts; tests may wrap them). */
export interface PrCheckoutOps {
  resolveRepo(subject: PrJobSubject, candidateCwds: string[]): Promise<{ match: PrRepoMatch }>;
  checkout: typeof checkoutPr;
  writeDiff(checkout: PrCheckout, subject: PrJobSubject): Promise<string | null>;
  fixTargetBranch: typeof fixTargetBranch;
  assertRemoteBranchAbsent: typeof assertRemoteBranchAbsent;
  finishFix: typeof finishPrFix;
  cleanup(checkout: PrCheckout): Promise<void>;
}

export const defaultPrCheckoutOps: PrCheckoutOps = {
  resolveRepo: (subject, cwds) => resolvePrRepo(subject, cwds),
  checkout: checkoutPr,
  writeDiff: (checkout, subject) => writePrDiff(checkout, subject),
  fixTargetBranch,
  assertRemoteBranchAbsent,
  finishFix: finishPrFix,
  cleanup: cleanupPrCheckout,
};

export interface PrJobOptions {
  /** Project dirs to look for a clone of the PR's repo in (default: the tracker's project dirs). */
  candidateCwds?: () => string[];
  /** Hard limit per run; the agent is killed and the job failed after it. */
  timeoutMs?: (kind: PrJobKind) => number;
  /** After submit_review, how long the agent may take to exit before it is closed. */
  exitGraceMs?: number;
  /** Agent progress events: minimum spacing and maximum count per run. */
  progressMinIntervalMs?: number;
  progressMaxEvents?: number;
  /** How often to check that the agent's PTY session still exists. */
  exitCheckIntervalMs?: number;
  /**
   * Review-only runner (cloud): pr_fix, and anything else that would push, is
   * refused before any checkout. Default false (local runners may fix).
   */
  reviewOnly?: boolean;
  ops?: Partial<PrCheckoutOps>;
}

export interface PrJobRunnerDeps {
  send(msg: CliToRelayMsg): void;
  /** Send a job-ending message and keep it for duplicate dispatches (JobRunner). */
  sendJobEnd(job: Job, msg: JobEndMsg): void;
  /** Record a finished attempt for duplicate detection (JobRunner). */
  rememberFinished(job: Job): void;
  getDriver(name: string): BaseDriver | undefined;
  createSession(driverName: string, cwd: string, opts: { print: boolean }): JobAgentSession | null;
  getSession(sessionId: string): JobAgentSession | null;
  closeSession(sessionId: string): void;
  announceSession(session: JobAgentSession, meta: { interactive: boolean; command: string }): void;
  workspace(): TicketWorkspaceWriter;
  mcpProvider(): McpSpawnConfigProvider;
  runnerId(job: Job): string;
  candidateCwds(): string[];
  now(): number;
  uuid(): string;
  options?: PrJobOptions;
}

interface PrRun {
  job: Job;
  msg: RelayRunJobMsg;
  reviewId: string;
  kind: PrJobKind;
  subject: PrJobSubject;
  subjectKey: string;
  attemptKey: string;
  driverName: string;
  /** Job ended (result sent, failed, cancelled or superseded): no further end messages. */
  finished: boolean;
  /** pr_fix: the agent exited and the runner is committing / pushing. */
  finishing: boolean;
  /** pr_fix: aborts the commit / push on cancel. */
  abort: AbortController | null;
  /** pr_fix: the in-flight git work (teardown waits for it before removing the worktree). */
  pushWork: Promise<unknown> | null;
  checkout: PrCheckout | null;
  pushBranch: string | null;
  session: JobAgentSession | null;
  mcp: McpSpawnConfig | undefined;
  mcpReleased: boolean;
  completion: { result: "success" | "needs_info" | "failed"; summary: string } | null;
  progressSent: number;
  /** Last agent progress event forwarded (CLI milestones do not count). */
  lastProgressAt: number;
  outputTail: string;
  disposers: (() => void)[];
  exitCheck?: () => void;
  /** Teardown in progress / done (memoised). */
  teardown: Promise<void> | null;
}

const DEFAULT_TIMEOUT_MS: Record<PrJobKind, number> = { pr_review: 30 * 60_000, pr_fix: 45 * 60_000 };
const OUTPUT_TAIL_MAX = 4 * 1024;
const RECENT_MAX = 200;
const STEP_MAX = 200;
const NOTE_MAX = 500;
const SUMMARY_MAX = 4000;
/** Flaio credentials a runner process may carry in its env (e.g. a cloud runner token): blanked for the agent. */
const FLAIO_SECRET_ENV = /^FLAIO_.*(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;

function jobAttemptKey(job: Pick<Job, "id" | "attempts">): string {
  return `${job.id}#${job.attempts}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export class PrJobRunner {
  private runs = new Map<string, PrRun>();
  /** Review ids of runs that ended recently: late MCP events for them are dropped, not forwarded as ticket events. */
  private recent = new Set<string>();
  private readonly ops: PrCheckoutOps;
  private readonly opts: PrJobOptions;

  constructor(private readonly deps: PrJobRunnerDeps) {
    this.opts = deps.options ?? {};
    this.ops = { ...defaultPrCheckoutOps, ...this.opts.ops };
  }

  // -------------------------------------------------------------------------
  // JobRunner integration
  // -------------------------------------------------------------------------

  /** True when MCP events for this id belong to a PR job (not a ticket). */
  owns(id: string): boolean {
    return this.runs.has(id) || this.recent.has(id);
  }

  /** Relay job ids of PR jobs still being set up, run or pushed. */
  activeJobIds(): string[] {
    const ids: string[] = [];
    for (const run of this.runs.values()) if (!run.finished) ids.push(run.job.id);
    return ids;
  }

  activeJobCount(): number {
    return this.activeJobIds().length;
  }

  /** PTY session of the PR run for a review id, if any. */
  getActiveSessionId(reviewId: string): string | null {
    return this.runs.get(reviewId)?.session?.id ?? null;
  }

  /** A relay_run_job for an attempt that is still running here (undefined = not a duplicate). */
  duplicate(msg: RelayRunJobMsg): string | null | undefined {
    const run = this.runs.get(this.reviewIdOf(msg));
    if (!run || run.finished || run.attemptKey !== jobAttemptKey(msg.job)) return undefined;
    if (!run.session) {
      debugLog(`pr-jobs: duplicate relay_run_job ${msg.job.id} (still setting up) — ignored`);
      return null;
    }
    debugLog(`pr-jobs: duplicate relay_run_job ${msg.job.id} (running) — re-sending cli_job_claimed`);
    this.sendClaimed(run);
    return run.session.id;
  }

  /** relay_cancel_job for a PR job. Returns false when the job is not a PR job of this process. */
  cancel(msg: RelayCancelJobMsg): boolean {
    const run = this.runs.get(msg.ticketId);
    if (!run || run.job.id !== msg.jobId) return false;
    debugLog(`pr-jobs: cancelling ${msg.jobId}: ${msg.reason}`);
    if (run.finishing && !run.finished) {
      // Abort the commit / push; finishFix reports whether the branch moved.
      debugLog(`pr-jobs: ${msg.jobId} is pushing; aborting the push`);
      run.abort?.abort();
    }
    run.finished = true;
    void this.teardown(run);
    return true;
  }

  /** Relay shutdown: stop PR agents and remove their worktrees (results can no longer be delivered). */
  dispose(): void {
    for (const run of [...this.runs.values()]) {
      run.finished = true;
      void this.teardown(run);
    }
  }

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  private reviewIdOf(msg: RelayRunJobMsg): string {
    return msg.ticket.id || msg.job.reviewId || msg.job.ticketId;
  }

  async run(msg: RelayRunJobMsg): Promise<string | null> {
    const { job } = msg;
    const kind = job.kind as PrJobKind;
    const reviewId = this.reviewIdOf(msg);
    const subject = job.subject;

    const refuse = (error: string): null => {
      debugLog(`pr-jobs: ${job.id} refused: ${error}`);
      this.deps.rememberFinished(job);
      this.deps.sendJobEnd(job, { type: "cli_job_failed", jobId: job.id, ticketId: reviewId, error });
      return null;
    };
    if (!subject || subject.type !== "pr") return refuse(`Job ${job.kind} has no pull request subject`);
    try {
      validatePrSubject(subject);
    } catch (err) {
      return refuse(errMessage(err));
    }
    if (kind === "pr_fix" && this.opts.reviewOnly) {
      return refuse("This runner is review-only (cloud runners do not push fixes). Run the fix on a local runner.");
    }
    if (kind === "pr_fix") {
      if (!job.fix) return refuse("pr_fix job has no fix input (findings and target)");
      try {
        checkFixTarget(subject, job.fix);
      } catch (err) {
        return refuse(errMessage(err));
      }
    }
    const driverName = msg.ticket.driverName || DEFAULT_DRIVER_NAME;
    if (!isSafeAgentArg(driverName)) return refuse("The job names an invalid driver");
    if (msg.ticket.model != null && msg.ticket.model !== "" && !isSafeAgentArg(msg.ticket.model)) {
      return refuse("The job names an invalid model");
    }
    const driver = this.deps.getDriver(driverName);
    if (!driver) return refuse(`Driver "${driverName}" not found`);
    if (!driver.ticketCapabilities.mcpConfig || !driver.ticketCapabilities.untrustedWorkspace) {
      return refuse(`Driver "${driverName}" cannot run pull request jobs (needs MCP config and untrusted-workspace isolation)`);
    }
    if (kind === "pr_fix" && !driver.ticketCapabilities.untrustedWorkspaceEdits) {
      return refuse(`Driver "${driverName}" can only review pull requests (it has no safe edit mode for untrusted code)`);
    }

    // One job per review id and per PR: a newer job supersedes the older one (no end message, like tickets).
    const subjectKey = jobSubjectKey(job);
    for (const other of [...this.runs.values()]) {
      if (other.reviewId === reviewId || other.subjectKey === subjectKey) {
        if (!other.finished) debugLog(`pr-jobs: job ${other.job.id} superseded by ${job.id}`);
        other.finished = true;
        void this.teardown(other);
      }
    }

    const run: PrRun = {
      job,
      msg,
      reviewId,
      kind,
      subject,
      subjectKey,
      attemptKey: jobAttemptKey(job),
      driverName,
      finished: false,
      finishing: false,
      abort: null,
      pushWork: null,
      checkout: null,
      pushBranch: null,
      session: null,
      mcp: undefined,
      mcpReleased: false,
      completion: null,
      progressSent: 0,
      lastProgressAt: 0,
      outputTail: "",
      disposers: [],
      teardown: null,
    };
    // Superseded runs may still be tearing down under the same review id: keep
    // them reachable for cleanup but route new events to this run.
    this.runs.set(reviewId, run);
    this.recent.delete(reviewId);

    try {
      return await this.setup(run, driver);
    } catch (err) {
      this.fail(run, err instanceof PrJobError ? err.message : `Pull request job setup failed: ${errMessage(err)}`);
      return null;
    }
  }

  private async setup(run: PrRun, driver: BaseDriver): Promise<string | null> {
    const { job, subject, kind } = run;
    const stale = () => run.finished || this.runs.get(run.reviewId) !== run;
    const abort = (): null => {
      debugLog(`pr-jobs: job ${job.id} cancelled or superseded during setup`);
      run.finished = true;
      void this.teardown(run);
      return null;
    };

    this.systemProgress(run, "Preparing checkout", "started", `${subject.owner}/${subject.repo}#${subject.number}`);
    const { match } = await this.ops.resolveRepo(subject, this.deps.candidateCwds());
    if (stale()) return abort();

    run.checkout = await this.ops.checkout(match, subject, {
      jobId: job.id,
      attempt: job.attempts,
      activeNames: this.activeCheckoutNames(),
    });
    if (stale()) return abort();
    const wt = run.checkout.worktreePath;

    if (kind === "pr_fix" && job.fix) {
      // Validate the push target before spending an agent run on it.
      run.pushBranch = await this.ops.fixTargetBranch(run.checkout.repoRoot, subject, job.fix, job.id);
      if (job.fix.target === "new_branch") {
        await this.ops.assertRemoteBranchAbsent(run.checkout.repoRoot, run.checkout.remote, run.pushBranch);
      }
      if (stale()) return abort();
    }

    const hasDiff = !!(await this.ops.writeDiff(run.checkout, subject));
    if (stale()) return abort();
    if (!hasDiff) {
      // Never review (or fix) blind.
      throw new PrJobError(
        "no_diff",
        `Could not compute the pull request's diff against ${subject.baseRef} (base branch missing or no common history); no agent was started.`,
      );
    }
    const workspace = this.deps.workspace();
    await workspace.ensureExcluded(wt).catch((err) => debugLog(`pr-jobs: ensureExcluded failed: ${errMessage(err)}`));
    await workspace.writeBrief(wt, run.msg.briefMarkdown, { ticketId: run.reviewId, jobId: job.id });
    if (stale()) return abort();
    const links = run.checkout.neutralisedLinks?.length ?? 0;
    this.systemProgress(
      run,
      "Preparing checkout",
      "done",
      `${run.checkout.headSha.slice(0, 12)}${links ? ` (${links} symlink(s) leaving the repository replaced)` : ""}`,
    );

    const perms = prAgentPermissions(kind);
    run.mcp = await this.deps.mcpProvider()(run.reviewId, job.id, {
      worktreePath: wt,
      toolset: perms.toolset,
      permissions: { allow: perms.allow, deny: perms.deny },
      stopHook: false,
      tokenInAgentEnv: false,
    });
    if (stale()) return abort();
    if (!run.mcp?.mcpConfigPath) {
      throw new Error("the Flaio MCP server is not available, so the agent could not report its result");
    }

    const session = this.deps.createSession(run.driverName, wt, { print: true });
    if (!session) throw new Error(`Failed to create agent session (driver "${run.driverName}")`);
    run.session = session;
    this.sendClaimed(run);
    this.wire(run);

    const promptOpts = { title: run.msg.ticket.title, hasDiff, pushBranch: run.pushBranch ?? undefined };
    const prompt =
      kind === "pr_review"
        ? buildPrReviewPrompt(job, subject, run.checkout.headSha, promptOpts)
        : buildPrFixPrompt(job, subject, run.checkout.headSha, promptOpts);
    const env: Record<string, string> = {
      ...this.blankedFlaioSecrets(),
      ...run.mcp.env,
      FLAIO_JOB_ID: job.id,
      FLAIO_JOB_KIND: kind,
      FLAIO_REVIEW_ID: run.reviewId,
    };
    const appendSystemPrompt = run.msg.systemInstructions.filter((s) => s.trim()).join("\n\n") || undefined;
    try {
      await session.startTicket(
        {
          sessionId: driver.ticketCapabilities.presetSessionId ? this.deps.uuid() : null,
          resume: false,
          permissionMode: prAgentPermissionMode(job.permissionMode),
          prompt,
          model: run.msg.ticket.model,
          mcpConfigPath: run.mcp.mcpConfigPath,
          settingsPath: run.mcp.settingsPath,
          appendSystemPrompt,
          print: true,
          allowedTools: perms.allow,
          untrustedWorkspace: true,
          readOnly: kind === "pr_review",
        },
        env,
      );
    } catch (err) {
      this.fail(run, `Agent failed to start: ${errMessage(err)}`);
      return null;
    }
    this.deps.announceSession(session, { interactive: false, command: `${run.driverName} -p "<${kind} prompt>"` });
    debugLog(`pr-jobs: started ${kind} job=${job.id} review=${run.reviewId} session=${session.id} cwd=${wt}`);
    return session.id;
  }

  private sendClaimed(run: PrRun): void {
    if (!run.session) return;
    this.deps.send({
      type: "cli_job_claimed",
      jobId: run.job.id,
      ticketId: run.reviewId,
      runnerId: this.deps.runnerId(run.job),
      sessionId: run.session.id,
    });
  }

  /** Names of checkouts owned by runs in this process (never swept as stale). */
  private activeCheckoutNames(): Set<string> {
    const names = new Set<string>();
    for (const r of this.runs.values()) if (r.checkout) names.add(r.checkout.name);
    return names;
  }

  private blankedFlaioSecrets(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of Object.keys(process.env)) if (FLAIO_SECRET_ENV.test(k)) out[k] = "";
    return out;
  }

  // -------------------------------------------------------------------------
  // Session wiring: exit, timeout, output tail
  // -------------------------------------------------------------------------

  private wire(run: PrRun): void {
    const session = run.session as JobAgentSession;
    run.disposers.push(
      session.onRawData((data) => {
        run.outputTail = (run.outputTail + data).slice(-OUTPUT_TAIL_MAX);
      }),
    );

    let fired = false;
    const fire = (code: number | undefined) => {
      if (fired) return;
      fired = true;
      void this.onExit(run, code);
    };
    const onExit = (code?: number) => fire(code);
    // closeSession() kills the PTY: status "exited" and no "exit" event.
    const onStatus = (status: AgentStatus) => {
      if (status !== "exited") return;
      setImmediate(() => {
        if (!this.deps.getSession(session.id)) fire(undefined);
      });
    };
    session.on("exit", onExit);
    session.on("status", onStatus);
    run.exitCheck = () => {
      if (!this.deps.getSession(session.id)) fire(undefined);
    };
    run.disposers.push(() => {
      session.removeListener("exit", onExit);
      session.removeListener("status", onStatus);
    });

    const check = setInterval(() => run.exitCheck?.(), this.opts.exitCheckIntervalMs ?? 30_000);
    check.unref?.();
    run.disposers.push(() => clearInterval(check));

    const timeoutMs = this.opts.timeoutMs?.(run.kind) ?? DEFAULT_TIMEOUT_MS[run.kind];
    const timer = setTimeout(() => {
      if (run.finished || run.finishing) return;
      this.fail(run, `Agent timed out after ${Math.round(timeoutMs / 60_000)}m without ${run.kind === "pr_review" ? "submitting a review" : "finishing"}`);
    }, timeoutMs);
    timer.unref?.();
    run.disposers.push(() => clearTimeout(timer));
  }

  private outputHint(run: PrRun): string {
    const tail = stripAnsi(run.outputTail).replace(/\s+/g, " ").trim();
    return tail ? ` Last output: ${clip(tail.slice(-400), 400)}` : "";
  }

  private async onExit(run: PrRun, code: number | undefined): Promise<void> {
    if (run.finished || run.finishing) {
      await this.teardown(run);
      return;
    }
    const codeText = `code ${code ?? "unknown"}`;
    if (run.kind === "pr_review") {
      this.fail(run, `Agent exited (${codeText}) without calling submit_review.${this.outputHint(run)}`);
      return;
    }
    if (!run.completion) {
      this.fail(run, `Agent exited (${codeText}) without calling complete_phase; nothing was pushed.${this.outputHint(run)}`);
      return;
    }
    if (run.completion.result !== "success") {
      this.end(run, {
        type: "cli_phase_complete",
        ticketId: run.reviewId,
        jobId: run.job.id,
        phase: "pr_fix",
        result: "failed",
        summary: clip(`Agent reported ${run.completion.result}; nothing was pushed. ${run.completion.summary}`, SUMMARY_MAX),
        testsRun: [],
      });
      await this.teardown(run);
      return;
    }
    await this.finishFix(run);
  }

  private async finishFix(run: PrRun): Promise<void> {
    const checkout = run.checkout as PrCheckout;
    const fix = run.job.fix as PrFixInput;
    const agentSummary = run.completion?.summary.trim() ?? "";
    run.finishing = true;
    run.abort = new AbortController();
    this.endListeners(run);
    this.systemProgress(run, "Pushing fixes", "started", run.pushBranch ?? undefined);
    let result: PrFixResult;
    const work = this.ops.finishFix(checkout, run.subject, fix, {
      jobId: run.job.id,
      commitMessage: clip(
        `Apply review fixes to #${run.subject.number}\n\n${agentSummary || "Fixes for the selected review findings."}\n\nFlaio-Review: ${run.reviewId}`,
        SUMMARY_MAX,
      ),
      signal: run.abort.signal,
    });
    run.pushWork = work.catch(() => undefined);
    try {
      result = await work;
    } catch (err) {
      run.finishing = false;
      if (run.finished) {
        // Cancelled: say truthfully what happened to the branch (the relay no longer expects a result).
        const pushed = err instanceof PrJobError ? err.pushed : null;
        this.sendProgress(run, "Pushing fixes", pushed ? "done" : "failed", clip(errMessage(err), NOTE_MAX), "flaio");
        debugLog(`pr-jobs: ${run.job.id} cancelled during the push: ${errMessage(err)}`);
        await this.teardown(run);
        return;
      }
      this.fail(run, err instanceof PrJobError ? err.message : `Pushing the fix failed: ${errMessage(err)}`);
      return;
    }
    run.finishing = false;
    if (run.finished) {
      // Cancelled after the push completed: the branch did move; say so.
      this.sendProgress(run, "Pushing fixes", "done", `Cancelled after the push completed: ${result.branch} @ ${result.commitSha.slice(0, 12)}`, "flaio");
      debugLog(`pr-jobs: ${run.job.id} pushed ${result.commitSha} to ${result.branch} before the cancel took effect`);
      await this.teardown(run);
      return;
    }
    this.systemProgress(run, "Pushing fixes", "done", `${result.branch} @ ${result.commitSha.slice(0, 12)}`);
    // The runner has no GitHub credentials: Flaio opens the stacked PR as the user once it has the branch.
    const stacked = fix.target === "new_branch" ? ` Flaio opens the stacked pull request from ${result.branch} into ${run.subject.headRef}.` : "";
    const summary = clip(
      `Pushed ${result.commitCount} commit(s) to ${result.branch} (${result.commitSha}).${stacked}\n\n${formatFixChanges(result.changes)}${agentSummary ? `\n\n${agentSummary}` : ""}`,
      SUMMARY_MAX,
    );
    this.end(run, {
      type: "cli_phase_complete",
      ticketId: run.reviewId,
      jobId: run.job.id,
      phase: "pr_fix",
      result: "success",
      summary,
      testsRun: [],
      gitContext: { branch: result.branch, headSha: result.commitSha },
    });
    await this.teardown(run);
  }

  // -------------------------------------------------------------------------
  // Ending
  // -------------------------------------------------------------------------

  /** Send the job-ending message once. */
  private end(run: PrRun, msg: JobEndMsg): void {
    if (run.finished) return;
    run.finished = true;
    this.deps.rememberFinished(run.job);
    this.deps.sendJobEnd(run.job, msg);
  }

  private fail(run: PrRun, error: string): void {
    debugLog(`pr-jobs: ${run.job.id} failed: ${error}`);
    this.end(run, { type: "cli_job_failed", jobId: run.job.id, ticketId: run.reviewId, error: clip(error, SUMMARY_MAX) });
    void this.teardown(run);
  }

  private endListeners(run: PrRun): void {
    const disposers = run.disposers;
    run.disposers = [];
    run.exitCheck = undefined;
    for (const d of disposers) {
      try {
        d();
      } catch {
        // best effort
      }
    }
  }

  private releaseMcp(run: PrRun): void {
    if (run.mcpReleased) return;
    run.mcpReleased = true;
    try {
      run.mcp?.dispose?.();
    } catch (err) {
      debugLog(`pr-jobs: disposing MCP config failed: ${errMessage(err)}`);
    }
  }

  /** Stop the agent, revoke its MCP session and remove the worktree (once). */
  private teardown(run: PrRun): Promise<void> {
    if (run.teardown) return run.teardown;
    run.teardown = (async () => {
      this.endListeners(run);
      if (run.session && this.deps.getSession(run.session.id)) this.deps.closeSession(run.session.id);
      this.releaseMcp(run);
      // Never remove the worktree under an in-flight commit / push (aborted on cancel).
      if (run.pushWork) await run.pushWork;
      if (run.checkout) {
        try {
          await this.ops.cleanup(run.checkout);
        } catch (err) {
          debugLog(`pr-jobs: cleanup of ${run.checkout.worktreePath} failed: ${errMessage(err)}`);
        }
      }
      if (this.runs.get(run.reviewId) === run) {
        this.runs.delete(run.reviewId);
        this.recent.add(run.reviewId);
        while (this.recent.size > RECENT_MAX) {
          const oldest = this.recent.values().next().value;
          if (oldest === undefined) break;
          this.recent.delete(oldest);
        }
      }
    })();
    return run.teardown;
  }

  // -------------------------------------------------------------------------
  // TicketPhaseBus events of PR runs (forwarded by JobRunner)
  // -------------------------------------------------------------------------

  private runFor(id: string, jobId: string | null): PrRun | null {
    const run = this.runs.get(id);
    if (!run) return null;
    if (jobId && jobId !== run.job.id) return null;
    return run;
  }

  onReviewSubmitted(p: TicketPhaseBusEvents["review_submitted"]): void {
    const run = this.runFor(p.ticketId, p.jobId);
    if (!run || run.kind !== "pr_review" || run.finished) {
      debugLog(`pr-jobs: submit_review for ${p.ticketId} with no running review — ignored`);
      return;
    }
    const review: SubmittedReview = p.review;
    this.end(run, {
      type: "cli_phase_complete",
      ticketId: run.reviewId,
      jobId: run.job.id,
      phase: "pr_review",
      result: "success",
      summary: clip(review.summary, SUMMARY_MAX),
      testsRun: [],
      review,
      ...(run.checkout ? { gitContext: { headSha: run.checkout.headSha } } : {}),
    });
    // The agent normally exits right after (print mode); close it if it lingers.
    const grace = setTimeout(() => void this.teardown(run), this.opts.exitGraceMs ?? 60_000);
    grace.unref?.();
    run.disposers.push(() => clearTimeout(grace));
  }

  onPhaseComplete(p: TicketPhaseBusEvents["phase_complete"]): void {
    const run = this.runFor(p.ticketId, p.jobId);
    if (!run || run.kind !== "pr_fix" || run.finished || run.finishing) return;
    // Acted on when the agent exits (the push must not race its last edits).
    run.completion = { result: p.completion.result, summary: p.completion.summary };
  }

  onProgress(p: TicketPhaseBusEvents["progress"]): void {
    const run = this.runFor(p.ticketId, p.jobId);
    if (!run || run.finished) return;
    const now = this.deps.now();
    const max = this.opts.progressMaxEvents ?? 60;
    const minInterval = this.opts.progressMinIntervalMs ?? 3_000;
    if (run.progressSent >= max) return;
    // Bounded rate: a burst of progress calls keeps only the first of each interval (done/failed always pass).
    const terminal = p.progress.status === "done" || p.progress.status === "failed";
    if (!terminal && run.lastProgressAt && now - run.lastProgressAt < minInterval) return;
    run.lastProgressAt = now;
    this.sendProgress(run, clip(p.progress.step, STEP_MAX), p.progress.status, p.progress.note);
  }

  /** CLI-side milestones (checkout, push): not rate-limited, still bounded in size. */
  private systemProgress(run: PrRun, step: string, status: "started" | "done" | "skipped" | "failed", note?: string): void {
    if (run.finished) return;
    this.sendProgress(run, step, status, note, "flaio");
  }

  private sendProgress(
    run: PrRun,
    step: string,
    status: "started" | "done" | "skipped" | "failed",
    note: string | undefined,
    actorId?: string,
  ): void {
    run.progressSent++;
    this.deps.send({
      type: "cli_ticket_event",
      ticketId: run.reviewId,
      jobId: run.job.id,
      event: {
        kind: "progress_reported",
        actor: { type: "agent", id: actorId ?? "agent", displayName: actorId ?? run.driverName },
        payload: { step, status, ...(note?.trim() ? { note: clip(note.trim(), NOTE_MAX) } : {}) },
        at: this.deps.now(),
      },
    });
  }
}
