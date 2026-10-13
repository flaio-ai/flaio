// ---------------------------------------------------------------------------
// JobRunner — the single path every ticket run goes through (WS-A1)
//
// relay_run_job (and the legacy relay_start_* / relay_request_changes, mapped
// in legacy-mapper.ts) → resolve worktree → write .flaio/ticket/brief.md →
// resume the ticket's agent session (or start one with a preset id) in the
// job's permission mode with the Flaio MCP server attached → report
// cli_job_claimed / cli_agent_session → forward TicketPhaseBus events as
// cli_ticket_event / cli_phase_complete.
//
// Success only comes from complete_phase. Terminal idleness can only produce
// cli_job_failed { stuck: true } after a configurable timeout.
// ---------------------------------------------------------------------------

import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stripAnsi } from "../../strip-ansi.js";
import type { Job, TicketAgentSession, TicketEventKind, TicketEventPayloads } from "../../contracts/agent-loop.js";
import { TICKET_WORKSPACE_DIR, TICKET_WORKSPACE_FILES } from "../../contracts/mcp-tools.js";
import { ticketPhaseBus, type TicketPhaseBus, type TicketPhaseBusEvents } from "../../contracts/ticket-phase-bus.js";
import type { AgentStatus, BaseDriver, TicketSpawnConfig, TicketSpawnOptions } from "../../agents/drivers/base-driver.js";
import type { AgentSessionInfo } from "../../agents/agent-session.js";
import {
  DEFAULT_DRIVER_NAME,
  type CliToRelayMsg,
  type RelayCancelJobMsg,
  type RelayRequestChangesMsg,
  type RelayRunJobMsg,
} from "../relay-protocol.js";
import type { TicketTracker } from "../ticket-tracker.js";
import { makeDebugLog } from "../../connectors/debug.js";
import {
  defaultTicketWorkspace,
  noMcpSpawnConfig,
  type McpSpawnConfig,
  type McpSpawnConfigProvider,
  type TicketWorkspaceWriter,
} from "./job-seams.js";
import { buildJobPrompt, isPlanKind } from "./job-prompts.js";
import { isLegacyJobId, mapRequestChanges, RESUME_KINDS, type LegacyRunContext, type RunJobOptions } from "./legacy-mapper.js";

const debugLog = makeDebugLog("jobs");

/** The subset of AgentSession the runner uses (lets tests pass a fake). */
export interface JobAgentSession {
  readonly id: string;
  readonly status: AgentStatus;
  startTicket(options: Omit<TicketSpawnOptions, "cwd">, extraEnv?: Record<string, string>): Promise<TicketSpawnConfig>;
  write(data: string): void;
  onRawData(listener: (data: string) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors EventEmitter's signature
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors EventEmitter's signature
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ResolvedWorktree {
  effectiveCwd: string;
  worktreePath: string | null;
  branchName: string | null;
}

export interface JobRunnerDeps {
  send(msg: CliToRelayMsg): void;
  /** Expand ~ and validate the requested project dir (throws when not allowed). */
  resolveCwd(cwd: string): string;
  resolveWorktree(resolvedCwd: string, ticketId: string, useWorktree: boolean): Promise<ResolvedWorktree>;
  getDriver(name: string): BaseDriver | undefined;
  /** Create (but do not start) a PTY-hosted agent session. */
  createSession(driverName: string, cwd: string, opts: { print: boolean }): JobAgentSession | null;
  getSession(sessionId: string): JobAgentSession | null;
  closeSession(sessionId: string): void;
  /** Called after spawn: set session meta / register with the relay. */
  announceSession(session: JobAgentSession, meta: { interactive: boolean; command: string }): void;
  tracker: TicketTracker;
  bus?: TicketPhaseBus;
  workspace?: TicketWorkspaceWriter;
  getMcpSpawnConfig?: McpSpawnConfigProvider;
  /** Idle time before a job is reported stuck. */
  idleTimeoutMs?: () => number;
  idleCheckIntervalMs?: number;
  /** Safety timeout for print-mode runs (legacy planning). */
  printTimeoutMs?: number;
  /** A resumed agent that exits non-zero within this window is retried as a fresh session. */
  resumeFailWindowMs?: number;
  now?: () => number;
  uuid?: () => string;
}

interface RunContext {
  msg: RelayRunJobMsg;
  options: RunJobOptions;
  driver: BaseDriver;
  driverName: string;
  resolvedCwd: string;
  workdir: string;
  branchName: string | null;
  mcp: McpSpawnConfig | undefined;
  runnerId: string;
}

interface ActiveRun {
  ctx: RunContext;
  job: Job;
  ticketId: string;
  legacy?: LegacyRunContext;
  session: JobAgentSession;
  agentSession: TicketAgentSession | null;
  resumed: boolean;
  spawnedAt: number;
  /** Ended (phase complete, failed, cancelled, superseded) — no further end messages. */
  finished: boolean;
  submittedPlan?: { steps: string[]; risks: string[]; files: string[]; markdown: string };
  idleSince: number | null;
  lastActivityAt: number;
  stuckReported: boolean;
  rawChunks: string[];
  rawSize: number;
  disposers: (() => void)[];
}

const IDLE_STATES: ReadonlySet<AgentStatus> = new Set(["waiting_input", "waiting_permission", "idle"]);
const RAW_OUTPUT_MAX = 2 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1000;

export class JobRunner {
  private runs = new Map<string, ActiveRun>();
  private workspace: TicketWorkspaceWriter;
  private getMcpSpawnConfig: McpSpawnConfigProvider;
  private readonly bus: TicketPhaseBus;
  private busDisposers: (() => void)[] = [];
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(private readonly deps: JobRunnerDeps) {
    this.workspace = deps.workspace ?? defaultTicketWorkspace;
    this.getMcpSpawnConfig = deps.getMcpSpawnConfig ?? noMcpSpawnConfig;
    this.bus = deps.bus ?? ticketPhaseBus;
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? randomUUID;
    this.attachBus();
  }

  // -------------------------------------------------------------------------
  // Integration seams (WS-A2)
  // -------------------------------------------------------------------------

  setTicketWorkspace(workspace: TicketWorkspaceWriter): void {
    this.workspace = workspace;
  }

  setMcpSpawnConfigProvider(provider: McpSpawnConfigProvider): void {
    this.getMcpSpawnConfig = provider;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** PTY session id of the active run for a ticket, if any. */
  getActiveSessionId(ticketId: string): string | null {
    return this.runs.get(ticketId)?.session.id ?? null;
  }

  /**
   * Run a job for a ticket. Returns the PTY session id hosting the agent, or
   * null when the run could not start (failure already reported).
   */
  async runJob(msg: RelayRunJobMsg, options: RunJobOptions = {}): Promise<string | null> {
    const { job, ticket } = msg;
    const tracker = this.deps.tracker;

    let resolvedCwd: string;
    try {
      resolvedCwd = this.deps.resolveCwd(ticket.cwd);
    } catch (err) {
      this.reportStartFailure(job, options.legacy, errMessage(err));
      return null;
    }

    const driverName = ticket.driverName || DEFAULT_DRIVER_NAME;
    const driver = this.deps.getDriver(driverName);
    if (!driver) {
      this.reportStartFailure(job, options.legacy, `Driver "${driverName}" not found`);
      return null;
    }

    let wt: ResolvedWorktree;
    try {
      wt = await this.deps.resolveWorktree(resolvedCwd, ticket.id, ticket.useWorktree);
    } catch (err) {
      this.reportStartFailure(job, options.legacy, `Worktree setup failed: ${errMessage(err)}`);
      return null;
    }
    const workdir = wt.effectiveCwd;

    // One agent per ticket: a new job supersedes whatever is still running.
    this.supersede(ticket.id);

    await this.prepareWorkspace(workdir, ticket.id, msg.briefMarkdown, options.briefMode ?? "replace");

    const prevEntry = tracker.get(ticket.id);
    tracker.upsert(ticket.id, {
      ticketTitle: ticket.title || prevEntry?.ticketTitle || "",
      originalCwd: resolvedCwd,
      worktreePath: wt.worktreePath ?? prevEntry?.worktreePath ?? null,
      branchName: wt.branchName ?? prevEntry?.branchName ?? null,
      driverName,
      model: ticket.model,
      useWorktree: ticket.useWorktree,
      lastJobKind: job.kind,
    });

    let mcp: McpSpawnConfig | undefined;
    try {
      mcp = await this.getMcpSpawnConfig(ticket.id, job.id);
    } catch (err) {
      debugLog(`jobs: getMcpSpawnConfig failed for ${ticket.id}: ${errMessage(err)}`);
    }

    const ctx: RunContext = {
      msg,
      options,
      driver,
      driverName,
      resolvedCwd,
      workdir,
      branchName: wt.branchName ?? prevEntry?.branchName ?? null,
      mcp,
      runnerId: job.runnerId ?? tracker.getRunnerId(),
    };
    return this.spawnRun(ctx, false);
  }

  /** relay_cancel_job: stop the agent for that job. */
  cancelJob(msg: RelayCancelJobMsg): boolean {
    const run = this.runs.get(msg.ticketId);
    if (!run || run.job.id !== msg.jobId) {
      debugLog(`jobs: cancel for unknown job ${msg.jobId} (ticket ${msg.ticketId})`);
      return false;
    }
    debugLog(`jobs: cancelling ${msg.jobId}: ${msg.reason}`);
    run.finished = true;
    this.deps.tracker.updateStatus(run.ticketId, "cancelled");
    this.deps.tracker.setActiveJob(run.ticketId, null);
    this.endRun(run);
    this.deps.closeSession(run.session.id);
    return true;
  }

  /**
   * relay_request_changes: type the feedback into the live agent when there is
   * one; otherwise resume the ticket's agent session with the feedback.
   */
  async requestChanges(msg: RelayRequestChangesMsg): Promise<"written" | "resumed" | "unknown"> {
    const tracker = this.deps.tracker;
    const ptyId = this.getActiveSessionId(msg.ticketId) ?? tracker.getSessionForTicket(msg.ticketId);
    const live = ptyId ? this.deps.getSession(ptyId) : null;
    if (live && live.status !== "exited") {
      const run = this.runs.get(msg.ticketId);
      if (run) {
        run.lastActivityAt = this.now();
        run.stuckReported = false;
      }
      live.write(msg.feedback + "\n");
      return "written";
    }

    const mapped = mapRequestChanges(msg, tracker.get(msg.ticketId), this.now());
    if (!mapped) {
      debugLog(`jobs: request_changes for unknown ticket ${msg.ticketId}`);
      this.deps.send({
        type: "cli_ticket_status",
        ticketId: msg.ticketId,
        sessionId: msg.sessionId,
        status: "error",
        message: "This runner has no session for the ticket; start the phase again.",
      });
      return "unknown";
    }
    await this.runJob(mapped.msg, mapped.options);
    return "resumed";
  }

  /** Detach from the bus and stop timers (relay shutdown). Agents keep running. */
  dispose(): void {
    for (const d of this.busDisposers) d();
    this.busDisposers = [];
    for (const run of this.runs.values()) this.endRun(run);
    this.runs.clear();
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /** Pick the agent session to resume, or null for a fresh one. */
  private resumableSession(ctx: RunContext): TicketAgentSession | null {
    const { job, ticket } = ctx.msg;
    const local = this.deps.tracker.get(ticket.id);
    const candidate =
      ticket.agentSession ?? (RESUME_KINDS.has(job.kind) ? (local?.agentSession ?? null) : null);
    if (!candidate) return null;
    if (!ctx.driver.ticketCapabilities.resume) return null;
    if (candidate.driver !== ctx.driverName) {
      debugLog(`jobs: session ${candidate.id} belongs to ${candidate.driver}, not ${ctx.driverName} — fresh session`);
      return null;
    }
    if (candidate.runnerId && candidate.runnerId !== ctx.runnerId) {
      debugLog(`jobs: session ${candidate.id} lives on runner ${candidate.runnerId} — fresh session`);
      return null;
    }
    // Claude stores sessions per project dir: resuming from another cwd fails.
    const sameLocalSession = local?.agentSession?.id === candidate.id;
    if (sameLocalSession && local?.agentCwd && local.agentCwd !== ctx.workdir) {
      debugLog(`jobs: session ${candidate.id} was created in ${local.agentCwd}, job runs in ${ctx.workdir} — fresh session`);
      return null;
    }
    return candidate;
  }

  private async spawnRun(ctx: RunContext, forceFresh: boolean): Promise<string | null> {
    const { job, ticket } = ctx.msg;
    const { options, driver } = ctx;
    const tracker = this.deps.tracker;
    const legacy = options.legacy;
    const print = !!options.print;

    const prev = forceFresh ? null : this.resumableSession(ctx);
    const resume = !!prev;
    const presetId = !resume && driver.ticketCapabilities.presetSessionId ? this.uuid() : null;
    const hadPrevious = !!(ticket.agentSession ?? tracker.getAgentSession(ticket.id));
    const hasMcp = !!ctx.mcp?.mcpConfigPath && driver.ticketCapabilities.mcpConfig;

    const prompt = options.buildPrompt
      ? options.buildPrompt({ resumed: resume, branchName: ctx.branchName, hasMcp })
      : buildJobPrompt(job, {
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          resumed: resume,
          freshAfterPrevious: !resume && hadPrevious,
          hasMcp,
          branchName: ctx.branchName,
        });

    const session = this.deps.createSession(ctx.driverName, ctx.workdir, { print });
    if (!session) {
      this.reportStartFailure(job, legacy, `Failed to create agent session (driver "${ctx.driverName}")`);
      return null;
    }

    const legacyStatus = legacy ? (legacy.mode === "implementation" ? "implementing" : "planning") : "running";
    tracker.upsert(ticket.id, { sessionId: session.id, status: legacyStatus });
    tracker.setActiveJob(ticket.id, { id: job.id, kind: job.kind, legacy: !!legacy, startedAt: this.now() });

    const run: ActiveRun = {
      ctx,
      job,
      ticketId: ticket.id,
      legacy,
      session,
      agentSession: null,
      resumed: resume,
      spawnedAt: this.now(),
      finished: false,
      idleSince: null,
      lastActivityAt: 0,
      stuckReported: false,
      rawChunks: [],
      rawSize: 0,
      disposers: [],
    };
    this.runs.set(ticket.id, run);

    if (legacy) {
      this.deps.send({
        type: "cli_ticket_status",
        ticketId: ticket.id,
        sessionId: session.id,
        status: legacyStatus === "implementing" ? "implementing" : "planning",
        branchName: ctx.branchName ?? undefined,
      });
    } else {
      this.deps.send({
        type: "cli_job_claimed",
        jobId: job.id,
        ticketId: ticket.id,
        runnerId: ctx.runnerId,
        sessionId: session.id,
      });
    }

    this.wireSession(run);

    const env: Record<string, string> = {
      ...ctx.mcp?.env,
      FLAIO_TICKET_ID: ticket.id,
      FLAIO_JOB_ID: job.id,
      FLAIO_JOB_KIND: job.kind,
    };
    const appendSystemPrompt = ctx.msg.systemInstructions.filter((s) => s.trim()).join("\n\n") || undefined;

    let config: TicketSpawnConfig;
    try {
      config = await session.startTicket(
        {
          sessionId: prev ? prev.id : presetId,
          resume,
          permissionMode: job.permissionMode,
          prompt,
          model: ticket.model,
          mcpConfigPath: ctx.mcp?.mcpConfigPath,
          appendSystemPrompt,
          print,
          allowedTools: options.allowedTools,
        },
        env,
      );
    } catch (err) {
      run.finished = true;
      this.endRun(run);
      this.runs.delete(ticket.id);
      this.deps.closeSession(session.id);
      this.reportStartFailure(job, legacy, `Agent failed to start: ${errMessage(err)}`, session.id);
      return null;
    }

    const command = `${ctx.driverName}${config.resumed ? ` --resume ${prev?.id ?? ""}` : ""}${print ? " -p" : ""} "<${job.kind} prompt>"`;
    this.deps.announceSession(session, { interactive: !print, command });

    if (config.agentSessionId) {
      const now = this.now();
      const sameAsPrev = !!prev && prev.id === config.agentSessionId;
      const agentSession: TicketAgentSession = {
        id: config.agentSessionId,
        driver: ctx.driverName,
        runnerId: ctx.runnerId,
        resumeCount: config.resumed && prev ? prev.resumeCount + 1 : 0,
        ...(sameAsPrev && prev?.transcriptPath ? { transcriptPath: prev.transcriptPath } : {}),
        ...(config.resumed ? { lastResumedAt: now } : {}),
      };
      this.publishAgentSession(run, agentSession);
    }

    debugLog(
      `jobs: started ${job.kind} job=${job.id} ticket=${ticket.id} session=${session.id} ` +
        `driver=${ctx.driverName} resumed=${config.resumed} agentSession=${config.agentSessionId ?? "?"} cwd=${ctx.workdir}`,
    );
    return session.id;
  }

  private wireSession(run: ActiveRun): void {
    const { session } = run;
    const print = !!run.ctx.options.print;

    if (print) {
      run.disposers.push(
        session.onRawData((data) => {
          if (run.rawSize < RAW_OUTPUT_MAX) {
            run.rawChunks.push(data);
            run.rawSize += data.length;
          }
        }),
      );
      const timeoutMs = this.deps.printTimeoutMs ?? 10 * 60 * 1000;
      const timer = setTimeout(() => {
        if (this.deps.getSession(session.id)) {
          debugLog(`jobs: print run ${session.id} timed out after ${timeoutMs}ms, closing`);
          this.deps.closeSession(session.id);
        }
      }, timeoutMs);
      timer.unref?.();
      run.disposers.push(() => clearTimeout(timer));
    } else {
      const onStatus = (status: AgentStatus) => {
        if (IDLE_STATES.has(status)) {
          if (run.idleSince === null) run.idleSince = this.now();
        } else if (status !== "exited") {
          run.idleSince = null;
          run.stuckReported = false;
        }
      };
      session.on("status", onStatus);
      run.disposers.push(() => session.removeListener("status", onStatus));
      if (IDLE_STATES.has(session.status)) run.idleSince = this.now();

      const interval = this.deps.idleCheckIntervalMs ?? 30_000;
      const timer = setInterval(() => this.checkIdle(run), interval);
      timer.unref?.();
      run.disposers.push(() => clearInterval(timer));
    }

    const onInfo = (info: AgentSessionInfo) => this.onAgentInfo(run, info);
    session.on("agent_session_info", onInfo);
    run.disposers.push(() => session.removeListener("agent_session_info", onInfo));

    const onExit = (code?: number) => this.onExit(run, code);
    session.on("exit", onExit);
    run.disposers.push(() => session.removeListener("exit", onExit));
  }

  /** Stop timers/listeners for a run (does not kill the agent). */
  private endRun(run: ActiveRun): void {
    const disposers = run.disposers;
    run.disposers = [];
    for (const d of disposers) {
      try {
        d();
      } catch {
        // best effort
      }
    }
  }

  /** Close any still-running agent for this ticket before starting a new one. */
  private supersede(ticketId: string): void {
    const run = this.runs.get(ticketId);
    if (!run) return;
    debugLog(`jobs: job ${run.job.id} superseded on ticket ${ticketId}`);
    run.finished = true;
    this.endRun(run);
    this.runs.delete(ticketId);
    if (this.deps.getSession(run.session.id)) this.deps.closeSession(run.session.id);
  }

  private async prepareWorkspace(
    workdir: string,
    ticketId: string,
    briefMarkdown: string,
    mode: "replace" | "append",
  ): Promise<void> {
    try {
      await this.workspace.ensureExcluded(workdir);
    } catch (err) {
      debugLog(`jobs: ensureExcluded failed in ${workdir}: ${errMessage(err)}`);
    }
    try {
      let markdown = briefMarkdown;
      if (mode === "append") {
        const existing = await fsp
          .readFile(path.join(workdir, TICKET_WORKSPACE_DIR, TICKET_WORKSPACE_FILES.brief), "utf-8")
          .catch(() => "");
        if (existing.trim()) markdown = `${existing.trimEnd()}\n\n${briefMarkdown}`;
      }
      await this.workspace.writeBrief(workdir, ticketId, markdown);
    } catch (err) {
      debugLog(`jobs: writing brief failed in ${workdir}: ${errMessage(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Agent session identity
  // -------------------------------------------------------------------------

  private publishAgentSession(run: ActiveRun, agentSession: TicketAgentSession): void {
    run.agentSession = agentSession;
    this.deps.tracker.setAgentSession(run.ticketId, agentSession, run.ctx.workdir);
    this.deps.send({ type: "cli_agent_session", ticketId: run.ticketId, agentSession: { ...agentSession } });
  }

  /** Sideband reported the agent's real session id / transcript path. */
  private onAgentInfo(run: ActiveRun, info: AgentSessionInfo): void {
    if (!info.agentSessionId && !info.transcriptPath) return;
    const cur = run.agentSession;
    if (!cur) {
      if (!info.agentSessionId) return;
      // Driver could not preset an id (e.g. Gemini): first report defines it.
      const prevLocal = this.deps.tracker.getAgentSession(run.ticketId);
      const resumedSame = run.resumed && prevLocal?.id === info.agentSessionId;
      this.publishAgentSession(run, {
        id: info.agentSessionId,
        driver: run.ctx.driverName,
        runnerId: run.ctx.runnerId,
        resumeCount: resumedSame && prevLocal ? prevLocal.resumeCount + 1 : 0,
        ...(info.transcriptPath ? { transcriptPath: info.transcriptPath } : {}),
        ...(resumedSame ? { lastResumedAt: this.now() } : {}),
      });
      return;
    }
    const idChanged = !!info.agentSessionId && info.agentSessionId !== cur.id;
    const transcriptChanged = !!info.transcriptPath && info.transcriptPath !== cur.transcriptPath;
    if (!idChanged && !transcriptChanged) return;
    if (idChanged) {
      debugLog(`jobs: agent reported session ${info.agentSessionId} (expected ${cur.id})`);
    }
    const next: TicketAgentSession = {
      ...cur,
      id: info.agentSessionId ?? cur.id,
      ...(info.transcriptPath ? { transcriptPath: info.transcriptPath } : {}),
    };
    if (idChanged && !info.transcriptPath) delete next.transcriptPath;
    this.publishAgentSession(run, next);
  }

  // -------------------------------------------------------------------------
  // Idle watchdog (stuck only — never "done")
  // -------------------------------------------------------------------------

  private checkIdle(run: ActiveRun): void {
    if (run.finished || run.stuckReported || run.idleSince === null) return;
    const timeout = this.deps.idleTimeoutMs?.() ?? DEFAULT_IDLE_TIMEOUT_MS;
    const since = Math.max(run.idleSince, run.lastActivityAt);
    const idleFor = this.now() - since;
    if (idleFor < timeout) return;

    run.stuckReported = true;
    const minutes = Math.round(idleFor / 60_000);
    const message = `Agent idle for ${minutes}m without calling complete_phase (waiting for input or stuck)`;
    debugLog(`jobs: ${run.job.id} ${message}`);
    this.deps.tracker.updateStatus(run.ticketId, "stuck");

    if (run.legacy) {
      // Legacy UI has no "stuck" state: keep the phase status and attach the message.
      this.deps.send({
        type: "cli_ticket_status",
        ticketId: run.ticketId,
        sessionId: run.session.id,
        status: run.legacy.mode === "implementation" ? "implementing" : "planning",
        message,
        branchName: run.ctx.branchName ?? undefined,
      });
    } else {
      this.deps.send({ type: "cli_job_failed", jobId: run.job.id, ticketId: run.ticketId, error: message, stuck: true });
    }
  }

  // -------------------------------------------------------------------------
  // Exit
  // -------------------------------------------------------------------------

  private onExit(run: ActiveRun, code: number | undefined): void {
    this.endRun(run);
    if (this.runs.get(run.ticketId) === run) this.runs.delete(run.ticketId);
    this.deps.tracker.clearSession(run.ticketId, run.session.id);
    if (run.finished) return;

    const window = this.deps.resumeFailWindowMs ?? 15_000;
    if (run.resumed && code !== 0 && this.now() - run.spawnedAt < window) {
      debugLog(`jobs: resume of ${run.agentSession?.id ?? "?"} failed fast (code ${code}) — retrying with a fresh session + brief`);
      run.finished = true;
      void this.spawnRun(run.ctx, true);
      return;
    }

    run.finished = true;
    this.deps.tracker.setActiveJob(run.ticketId, null);

    if (run.legacy) {
      this.finishLegacyOnExit(run, code);
      return;
    }
    this.deps.tracker.updateStatus(run.ticketId, "failed");
    this.deps.send({
      type: "cli_job_failed",
      jobId: run.job.id,
      ticketId: run.ticketId,
      error: `Agent exited (code ${code ?? "unknown"}) before calling complete_phase`,
    });
  }

  private finishLegacyOnExit(run: ActiveRun, code: number | undefined): void {
    const legacy = run.legacy as LegacyRunContext;
    if (legacy.mode === "planning_print") {
      // Fallback: no submit_plan/complete_phase → stdout is the plan (pre-job behaviour).
      const plan = run.submittedPlan?.markdown ?? stripAnsi(run.rawChunks.join("")).trim();
      run.rawChunks = [];
      run.rawSize = 0;
      this.emitLegacyPlanReady(run, plan);
    } else if (legacy.mode === "implementation") {
      this.deps.tracker.updateStatus(run.ticketId, "done");
      this.deps.send({
        type: "cli_implementation_done",
        ticketId: run.ticketId,
        sessionId: run.session.id,
        summary: `(session exited${code !== undefined ? ` with code ${code}` : ""})`,
        gitContext: { branch: run.ctx.branchName ?? undefined },
      });
      this.sendLegacyStatus(run, "done");
    } else {
      // Interactive planning never reported completion on exit before; keep that.
      this.deps.tracker.updateStatus(run.ticketId, "idle");
    }
  }

  private emitLegacyPlanReady(run: ActiveRun, plan: string): void {
    const legacy = run.legacy as LegacyRunContext;
    this.deps.tracker.updateStatus(run.ticketId, "plan_ready");
    this.deps.send({
      type: "cli_plan_ready",
      ticketId: run.ticketId,
      sessionId: run.session.id,
      plan,
      iteration: legacy.iteration,
      feedback: legacy.feedback,
      branchName: run.ctx.branchName ?? undefined,
    });
    this.sendLegacyStatus(run, "plan_ready");
  }

  private sendLegacyStatus(
    run: ActiveRun,
    status: "planning" | "plan_ready" | "implementing" | "done" | "error",
    message?: string,
  ): void {
    this.deps.send({
      type: "cli_ticket_status",
      ticketId: run.ticketId,
      sessionId: run.session.id,
      status,
      ...(message ? { message } : {}),
      branchName: run.ctx.branchName ?? undefined,
    });
  }

  private reportStartFailure(job: Job, legacy: LegacyRunContext | undefined, error: string, sessionId = ""): void {
    debugLog(`jobs: ${job.id} failed to start: ${error}`);
    this.deps.tracker.updateStatus(job.ticketId, "failed");
    if (legacy) {
      this.deps.send({ type: "cli_ticket_status", ticketId: job.ticketId, sessionId, status: "error", message: error });
    } else {
      this.deps.send({ type: "cli_job_failed", jobId: job.id, ticketId: job.ticketId, error });
    }
  }

  // -------------------------------------------------------------------------
  // TicketPhaseBus → relay
  // -------------------------------------------------------------------------

  private attachBus(): void {
    const on = <E extends keyof TicketPhaseBusEvents>(event: E, fn: (p: TicketPhaseBusEvents[E]) => void) => {
      const listener = (p: TicketPhaseBusEvents[E]) => {
        try {
          fn(p);
        } catch (err) {
          debugLog(`jobs: bus ${event} handler failed: ${errMessage(err)}`);
        }
      };
      this.bus.onEvent(event, listener);
      this.busDisposers.push(() => this.bus.offEvent(event, listener));
    };
    on("plan_submitted", (p) => this.onPlanSubmitted(p));
    on("question", (p) => this.onQuestion(p));
    on("decision", (p) => this.onDecision(p));
    on("progress", (p) => this.onProgress(p));
    on("phase_complete", (p) => this.onPhaseComplete(p));
  }

  /** The active run an MCP event belongs to (null when stale or unknown). */
  private runFor(ticketId: string, jobId: string | null): ActiveRun | null {
    const run = this.runs.get(ticketId);
    if (!run) return null;
    if (jobId && jobId !== run.job.id) return null;
    run.lastActivityAt = this.now();
    run.stuckReported = false;
    return run;
  }

  /** Job id to put on the wire: never leak synthetic legacy ids. */
  private wireJobId(run: ActiveRun | null, jobId: string | null): string | null {
    const id = jobId ?? run?.job.id ?? null;
    if (!id) return null;
    if (run?.legacy && id === run.job.id) return null;
    return isLegacyJobId(id) ? null : id;
  }

  private sendEvent<K extends TicketEventKind>(
    ticketId: string,
    run: ActiveRun | null,
    jobId: string | null,
    kind: K,
    payload: TicketEventPayloads[K],
  ): void {
    const agentId = run?.agentSession?.id ?? this.deps.tracker.getAgentSession(ticketId)?.id ?? "agent";
    const driverName = run?.ctx.driverName ?? this.deps.tracker.get(ticketId)?.driverName;
    this.deps.send({
      type: "cli_ticket_event",
      ticketId,
      jobId: this.wireJobId(run, jobId),
      event: {
        kind,
        actor: { type: "agent", id: agentId, ...(driverName ? { displayName: driverName } : {}) },
        payload,
        at: this.now(),
      },
    });
  }

  private onPlanSubmitted(p: TicketPhaseBusEvents["plan_submitted"]): void {
    const run = this.runFor(p.ticketId, p.jobId);
    const plan = {
      steps: p.plan.steps,
      risks: p.plan.risks ?? [],
      files: p.plan.files ?? [],
      markdown: p.plan.markdown,
    };
    if (run) run.submittedPlan = plan;
    const counter = this.deps.tracker.nextPlanIteration(p.ticketId);
    const iteration = run?.legacy ? run.legacy.iteration : counter;
    this.sendEvent(p.ticketId, run, p.jobId, "plan_submitted", { ...plan, iteration });
  }

  private onQuestion(p: TicketPhaseBusEvents["question"]): void {
    const run = this.runFor(p.ticketId, p.jobId);
    this.sendEvent(p.ticketId, run, p.jobId, "question_asked", {
      questionId: p.questionId,
      text: p.question.text,
      blocking: p.question.blocking ?? true,
    });
  }

  private onDecision(p: TicketPhaseBusEvents["decision"]): void {
    const run = this.runFor(p.ticketId, p.jobId);
    this.sendEvent(p.ticketId, run, p.jobId, "decision_recorded", {
      title: p.decision.title,
      rationale: p.decision.rationale,
    });
  }

  private onProgress(p: TicketPhaseBusEvents["progress"]): void {
    const run = this.runFor(p.ticketId, p.jobId);
    this.sendEvent(p.ticketId, run, p.jobId, "progress_reported", {
      step: p.progress.step,
      status: p.progress.status,
      ...(p.progress.note ? { note: p.progress.note } : {}),
    });
  }

  private onPhaseComplete(p: TicketPhaseBusEvents["phase_complete"]): void {
    const run = this.runFor(p.ticketId, p.jobId);
    const { result, summary } = p.completion;
    const testsRun = p.completion.testsRun ?? [];
    const kind = run?.job.kind ?? this.deps.tracker.get(p.ticketId)?.lastJobKind;
    if (!kind) {
      debugLog(`jobs: phase_complete for ticket ${p.ticketId} with no known job — ignored`);
      return;
    }
    this.sendEvent(p.ticketId, run, p.jobId, "phase_completed", { phase: kind, result, summary, testsRun });

    const tracker = this.deps.tracker;
    const status =
      result === "success" ? (isPlanKind(kind) ? "plan_ready" : "done") : result === "needs_info" ? "needs_info" : "failed";
    tracker.updateStatus(p.ticketId, status);

    if (!run) {
      const jobId = this.wireJobId(null, p.jobId);
      if (jobId) {
        this.deps.send({ type: "cli_phase_complete", ticketId: p.ticketId, jobId, phase: kind, result, summary, testsRun });
      }
      return;
    }
    if (run.finished) return;
    run.finished = true;
    tracker.setActiveJob(p.ticketId, null);
    // The agent stays open (interactive users can keep watching / typing);
    // only the watchdog stops. The next job for the ticket supersedes it.
    this.endRunTimersOnly(run);

    if (run.legacy) {
      this.finishLegacyOnComplete(run, result, summary);
      return;
    }
    const branch = run.ctx.branchName ?? undefined;
    this.deps.send({
      type: "cli_phase_complete",
      ticketId: p.ticketId,
      jobId: run.job.id,
      phase: kind,
      result,
      summary,
      testsRun,
      ...(isPlanKind(kind) && run.submittedPlan ? { plan: run.submittedPlan } : {}),
      ...(branch ? { gitContext: { branch } } : {}),
    });
  }

  /** After completion keep the exit listener (to clear the PTY mapping) but drop the rest. */
  private endRunTimersOnly(run: ActiveRun): void {
    this.endRun(run);
    const onExit = () => {
      if (this.runs.get(run.ticketId) === run) this.runs.delete(run.ticketId);
      this.deps.tracker.clearSession(run.ticketId, run.session.id);
    };
    run.session.on("exit", onExit);
    run.disposers.push(() => run.session.removeListener("exit", onExit));
  }

  private finishLegacyOnComplete(run: ActiveRun, result: "success" | "needs_info" | "failed", summary: string): void {
    const legacy = run.legacy as LegacyRunContext;
    const planning = legacy.mode !== "implementation";
    if (result !== "success") {
      this.sendLegacyStatus(run, "error", `${result === "needs_info" ? "Agent needs more information" : "Agent reported failure"}: ${summary}`);
      return;
    }
    if (planning) {
      this.emitLegacyPlanReady(run, run.submittedPlan?.markdown ?? summary);
      return;
    }
    this.deps.tracker.updateStatus(run.ticketId, "done");
    this.deps.send({
      type: "cli_implementation_done",
      ticketId: run.ticketId,
      sessionId: run.session.id,
      summary,
      gitContext: { branch: run.ctx.branchName ?? undefined },
    });
    this.sendLegacyStatus(run, "done");
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
