// ---------------------------------------------------------------------------
// `flaio runner --once`: the headless cloud runner flow.
//
//   connect → cli_auth (one-time runner token) → cli_request_job_secrets (once)
//   → shallow clone → register the checkout → cli_runner_register (kind cloud)
//   → wait for relay_run_job of exactly FLAIO_JOB_ID → JobRunner.runJob
//   → job end (cli_phase_complete / cli_job_failed) → cli_job_usage → exit.
//
// Every wait has a timeout, the whole run has a hard deadline, and a relay
// disconnect ends the run at once (no reconnect: the token is single-use).
// ---------------------------------------------------------------------------

import type { JobSecrets } from "../contracts/agent-loop.js";
import type {
  CliToRelayMsg,
  RelayCancelJobMsg,
  RelayJobSecretsMsg,
  RelayRunJobMsg,
} from "../relay/relay-protocol.js";
import { RelayToCliMsgSchema } from "../relay/relay-message-schemas.js";
import { normalizeRepoUrl } from "../relay/runner-info.js";
import type { ConnectRelay, RelayLink } from "./relay-link.js";
import { cloneUrl } from "./git-checkout.js";
import { RUNNER_EXIT, type RunnerConfig, type RunnerExitCode } from "./runner-config.js";
import type { RunnerUsage } from "./usage.js";

/** The JobRunner surface the cloud runner drives. */
export interface RunnerJobRunner {
  runJob(msg: RelayRunJobMsg): Promise<string | null>;
  cancelJob(msg: RelayCancelJobMsg): boolean;
  activeJobIds(): string[];
  activeJobCount(): number;
  dispose(): void;
}

export interface JobRunnerContext {
  /** Send to the relay (the runner watches it for the job end). */
  send(msg: CliToRelayMsg): void;
  secrets: JobSecrets;
  checkoutPath: string;
}

export interface CloudRunnerDeps {
  config: RunnerConfig;
  connect: ConnectRelay;
  /** Shallow clone of `repository`; returns the checkout path. */
  clone(opts: { repository: string; token: string | null; dir: string }): Promise<string>;
  /** Build the JobRunner (real: AgentSession + MCP + hook server). */
  createJobRunner(ctx: JobRunnerContext): RunnerJobRunner;
  /** Make the checkout the project dir for this job's ticket id (stream F's resolution). */
  registerCheckout(ticketId: string, checkoutPath: string, repository: string): void;
  /** Hand the GitHub token to git in the runner process (null = remove). */
  setGitToken(token: string | null): void;
  /** Usage collected from the agent output so far. */
  usage(): RunnerUsage;
  /** Installed agent drivers to report (the cloud image has opencode). */
  drivers: string[];
  cliVersion: string;
  hostname: string;
  log(line: string): void;
  now?: () => number;
  uuid?: () => string;
}

/** Driver the cloud runner always uses. */
export const CLOUD_DRIVER = "opencode";

export class CloudRunner {
  private link: RelayLink | null = null;
  private jobRunner: RunnerJobRunner | null = null;
  private secrets: JobSecrets | null = null;
  private secretsRequested = false;
  private jobStartedAt: number | null = null;
  private jobEnded = false;
  private model: string | null = null;
  private ticketId: string | null = null;
  private finished = false;
  private resolveDone!: (code: RunnerExitCode) => void;
  private readonly done: Promise<RunnerExitCode>;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private waiters: ((msg: Record<string, unknown>) => boolean)[] = [];
  private readonly now: () => number;
  private readonly uuid: () => string;
  readonly runnerId: string;

  constructor(private readonly deps: CloudRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? (() => Math.random().toString(36).slice(2));
    this.runnerId = `cloud-${deps.config.jobId}`;
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  /** Run the assigned job; resolves with the process exit code. Never rejects. */
  async run(): Promise<RunnerExitCode> {
    const { config } = this.deps;
    this.timer(config.timeoutMs, () => this.finish(RUNNER_EXIT.TIMEOUT, `hard timeout after ${config.timeoutMs}ms`));
    void this.steps().catch((err: unknown) => {
      const e = err as { exitCode?: RunnerExitCode };
      this.finish(e.exitCode ?? RUNNER_EXIT.JOB_FAILED, errMessage(err));
    });
    return this.done;
  }

  private async steps(): Promise<void> {
    const { config } = this.deps;

    // 1. Connect and authenticate with the one-time runner token.
    const link = await this.withTimeout(this.deps.connect(config.relayUrl), config.connectTimeoutMs, RUNNER_EXIT.DISCONNECTED, "connect");
    if (this.finished) {
      link.close();
      return;
    }
    this.link = link;
    link.onClose((reason) => this.finish(RUNNER_EXIT.DISCONNECTED, `relay ${reason}`));
    link.onMessage((msg) => this.onMessage(msg));
    const auth = this.waitFor((m) => m.type === "relay_auth_ok" || m.type === "relay_auth_fail");
    link.send({ type: "cli_auth", token: config.token });
    const authMsg = await this.withTimeout(auth, config.connectTimeoutMs, RUNNER_EXIT.AUTH, "auth");
    if (authMsg.type !== "relay_auth_ok") {
      throw exitError(RUNNER_EXIT.AUTH, `relay rejected the runner token: ${String(authMsg.reason ?? "")}`);
    }
    this.deps.log("authenticated");

    // 2. Job-scoped secrets, requested exactly once.
    const secrets = await this.requestSecrets();
    this.secrets = secrets;
    this.model = secrets.model ?? null;

    // 3. Shallow clone with the single-repo token.
    if (!secrets.github) throw exitError(RUNNER_EXIT.SECRETS, "no repository access was granted for this job");
    const repository = secrets.github.repository;
    let checkoutPath: string;
    try {
      checkoutPath = await this.deps.clone({ repository, token: secrets.github.token, dir: config.workDir });
    } catch (err) {
      throw exitError(RUNNER_EXIT.CHECKOUT, errMessage(err));
    }
    if (this.finished) return;
    this.deps.setGitToken(secrets.github.token);
    this.deps.log(`cloned ${repository}`);

    // 4. JobRunner + runner registration (kind cloud, this repo only).
    this.jobRunner = this.deps.createJobRunner({ send: (msg) => this.sendFromJob(msg), secrets, checkoutPath });
    const runJob = this.waitFor((m) => m.type === "relay_run_job" && isRecord(m.job) && m.job.id === config.jobId);
    this.send({
      type: "cli_runner_register",
      runner: {
        id: this.runnerId,
        orgId: null,
        kind: "cloud",
        hostname: this.deps.hostname,
        drivers: this.deps.drivers,
        repos: [normalizeRepoUrl(cloneUrl(repository))],
        maxConcurrent: 1,
        cliVersion: this.deps.cliVersion,
      },
      activeJobIds: [],
    });
    this.heartbeat = setInterval(() => {
      this.send({
        type: "cli_runner_heartbeat",
        runnerId: this.runnerId,
        activeJobs: this.jobRunner?.activeJobCount() ?? 0,
        activeJobIds: this.jobRunner?.activeJobIds() ?? [],
      });
    }, config.heartbeatMs);
    this.heartbeat.unref?.();

    // 5. Exactly the assigned job.
    const raw = await this.withTimeout(runJob, config.claimTimeoutMs, RUNNER_EXIT.NO_JOB, "relay_run_job");
    const parsed = RelayToCliMsgSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== "relay_run_job") {
      throw exitError(RUNNER_EXIT.JOB_FAILED, "invalid relay_run_job message");
    }
    const msg = this.prepareJob(parsed.data as RelayRunJobMsg, checkoutPath, repository);
    this.jobStartedAt = this.now();
    this.deps.log(`running ${msg.job.kind} job ${msg.job.id}`);
    const sessionId = await this.jobRunner.runJob(msg);
    if (!sessionId && !this.jobEnded) {
      // runJob reported the failure itself (cli_job_failed); the end handler finishes.
      this.deps.log("job did not start");
    }
  }

  /** Force the cloud harness and the secrets' model; bind the checkout. */
  private prepareJob(msg: RelayRunJobMsg, checkoutPath: string, repository: string): RelayRunJobMsg {
    this.ticketId = msg.ticket.id;
    this.deps.registerCheckout(msg.ticket.id, checkoutPath, repository);
    const model = this.secrets?.model ?? msg.ticket.model ?? null;
    this.model = model;
    return {
      ...msg,
      job: { ...msg.job, runnerId: this.runnerId },
      ticket: { ...msg.ticket, driverName: CLOUD_DRIVER, model, agentSession: null },
    };
  }

  private async requestSecrets(): Promise<JobSecrets> {
    if (this.secretsRequested) throw exitError(RUNNER_EXIT.SECRETS, "secrets already requested");
    this.secretsRequested = true;
    const requestId = this.uuid();
    const reply = this.waitFor((m) => m.type === "relay_job_secrets" && m.requestId === requestId);
    this.send({ type: "cli_request_job_secrets", requestId, runnerId: this.runnerId, jobId: this.deps.config.jobId });
    const msg = (await this.withTimeout(
      reply,
      this.deps.config.secretsTimeoutMs,
      RUNNER_EXIT.SECRETS,
      "relay_job_secrets",
    )) as unknown as RelayJobSecretsMsg;
    if (!msg.ok || !msg.secrets) {
      throw exitError(RUNNER_EXIT.SECRETS, `secrets refused: ${msg.error ?? "unknown reason"}`);
    }
    const s = msg.secrets;
    if (typeof s.providerApiKey !== "string" || !s.providerApiKey || typeof s.provider !== "string") {
      throw exitError(RUNNER_EXIT.SECRETS, "secrets response is malformed");
    }
    if (typeof s.expiresAt !== "number" || s.expiresAt <= this.now()) {
      throw exitError(RUNNER_EXIT.SECRETS, "secrets already expired");
    }
    // Stop the run when the secrets expire: nothing may use them afterwards.
    this.timer(Math.max(0, s.expiresAt - this.now()), () => this.finish(RUNNER_EXIT.TIMEOUT, "job secrets expired"));
    return s;
  }

  private onMessage(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.type !== "string") return;
    this.waiters = this.waiters.filter((w) => !w(raw));
    switch (raw.type) {
      case "relay_ping":
        this.send({ type: "cli_pong" });
        break;
      case "relay_cancel_job": {
        const parsed = RelayToCliMsgSchema.safeParse(raw);
        if (!parsed.success || parsed.data.type !== "relay_cancel_job") break;
        if (parsed.data.jobId !== this.deps.config.jobId) break;
        this.jobRunner?.cancelJob(parsed.data);
        this.finish(RUNNER_EXIT.CANCELLED, `cancelled: ${parsed.data.reason}`);
        break;
      }
      case "relay_run_job": {
        // A cloud runner is bound to one job: refuse anything else.
        const job = isRecord(raw.job) ? raw.job : null;
        if (job && job.id !== this.deps.config.jobId && typeof job.id === "string") {
          this.send({
            type: "cli_job_failed",
            jobId: job.id,
            ticketId: typeof job.ticketId === "string" ? job.ticketId : "",
            error: "This cloud runner is bound to another job",
          });
        }
        break;
      }
    }
  }

  /** JobRunner → relay. Watches for the end of the assigned job. */
  private sendFromJob(msg: CliToRelayMsg): void {
    this.send(msg);
    if ((msg.type === "cli_phase_complete" || msg.type === "cli_job_failed") && msg.jobId === this.deps.config.jobId) {
      this.jobEnded = true;
      const ok = msg.type === "cli_phase_complete" && msg.result !== "failed";
      this.finish(ok ? RUNNER_EXIT.OK : RUNNER_EXIT.JOB_FAILED, ok ? "job finished" : `job failed: ${summaryOf(msg)}`);
    }
  }

  private send(msg: CliToRelayMsg): void {
    if (this.link?.open) this.link.send(msg);
  }

  private finish(code: RunnerExitCode, reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.deps.log(`exit ${code}: ${reason}`);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;

    const linkOpen = !!this.link?.open;
    if (linkOpen && this.jobStartedAt !== null && !this.jobEnded) {
      this.send({
        type: "cli_job_failed",
        jobId: this.deps.config.jobId,
        ticketId: this.ticketId ?? "",
        error: `Cloud runner stopped: ${reason}`,
      });
    }
    if (linkOpen && this.secrets) {
      const usage = this.deps.usage();
      this.send({
        type: "cli_job_usage",
        jobId: this.deps.config.jobId,
        runnerId: this.runnerId,
        usage: {
          ...usage,
          model: this.model,
          durationMs: this.jobStartedAt === null ? 0 : Math.max(0, this.now() - this.jobStartedAt),
        },
      });
    }
    try {
      this.jobRunner?.dispose();
    } catch {}
    this.deps.setGitToken(null);
    this.secrets = null;
    this.link?.close();
    this.waiters = [];
    this.resolveDone(code);
  }

  private waitFor(match: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.waiters.push((m) => {
        if (!match(m)) return false;
        resolve(m);
        return true;
      });
    });
  }

  private withTimeout<T>(p: Promise<T>, ms: number, code: RunnerExitCode, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = this.timer(ms, () => reject(exitError(code, `timed out waiting for ${what}`)));
      p.then(
        (v) => {
          clearTimeout(t);
          this.timers.delete(t);
          resolve(v);
        },
        (err: unknown) => {
          clearTimeout(t);
          this.timers.delete(t);
          reject(isExitError(err) ? err : exitError(code, errMessage(err)));
        },
      );
    });
  }

  private timer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }
}

interface ExitError extends Error {
  exitCode: RunnerExitCode;
}

function exitError(exitCode: RunnerExitCode, message: string): ExitError {
  return Object.assign(new Error(message), { exitCode });
}

function isExitError(err: unknown): err is ExitError {
  return err instanceof Error && typeof (err as Partial<ExitError>).exitCode === "number";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summaryOf(msg: Extract<CliToRelayMsg, { type: "cli_phase_complete" | "cli_job_failed" }>): string {
  return msg.type === "cli_job_failed" ? msg.error : msg.summary;
}
