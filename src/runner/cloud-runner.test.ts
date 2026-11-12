import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job, JobSecrets } from "../contracts/agent-loop.js";
import type { CliToRelayMsg, RelayRunJobMsg } from "../relay/relay-protocol.js";
import { CloudRunner, type CloudRunnerDeps, type JobRunnerContext, type RunnerJobRunner } from "./cloud-runner.js";
import type { RelayLink } from "./relay-link.js";
import { RUNNER_EXIT, type RunnerConfig } from "./runner-config.js";

const JOB_ID = "job_1";

// ---- Fake relay ------------------------------------------------------------

class FakeRelay {
  sent: CliToRelayMsg[] = [];
  private messageListeners: ((m: unknown) => void)[] = [];
  private closeListeners: ((r: string) => void)[] = [];
  open = true;
  /** Auto-replies, per request type. */
  onSend: (msg: CliToRelayMsg, relay: FakeRelay) => void = () => {};

  link(): RelayLink {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const relay = this;
    return {
      send: (msg) => {
        relay.sent.push(msg);
        queueMicrotask(() => relay.onSend(msg, relay));
      },
      onMessage: (l) => relay.messageListeners.push(l),
      onClose: (l) => relay.closeListeners.push(l),
      close: () => relay.drop("client close"),
      get open() {
        return relay.open;
      },
    };
  }

  push(msg: unknown): void {
    for (const l of this.messageListeners) l(msg);
  }

  drop(reason = "server gone"): void {
    if (!this.open) return;
    this.open = false;
    for (const l of this.closeListeners) l(reason);
  }

  ofType<T extends CliToRelayMsg["type"]>(type: T): Extract<CliToRelayMsg, { type: T }>[] {
    return this.sent.filter((m) => m.type === type) as Extract<CliToRelayMsg, { type: T }>[];
  }
}

function secrets(over: Partial<JobSecrets> = {}): JobSecrets {
  return {
    provider: "openrouter",
    providerApiKey: "sk-or-secret",
    model: "anthropic/claude-x",
    github: { token: "ghs_x", repository: "acme/web", access: "read", expiresAt: Date.now() + 60_000 },
    expiresAt: Date.now() + 60_000,
    ...over,
  };
}

function runJobMsg(jobId = JOB_ID): RelayRunJobMsg {
  const job: Job = {
    id: jobId,
    ticketId: "review_1",
    ownerUid: "u1",
    orgId: null,
    kind: "pr_review",
    prompt: null,
    permissionMode: "plan",
    status: "claimed",
    runnerId: "cloud-job_1",
    leaseExpiresAt: null,
    attempts: 1,
    maxAttempts: 1,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    type: "relay_run_job",
    job,
    ticket: { id: "review_1", title: "PR", cwd: "", useWorktree: true, driverName: "claude", model: null, agentSession: null },
    briefMarkdown: "# brief",
    systemInstructions: [],
  };
}

/** Standard relay: auth ok, secrets once, then dispatch the job after registration. */
function standardRelay(opts: { secrets?: JobSecrets; dispatch?: boolean } = {}): FakeRelay {
  const relay = new FakeRelay();
  relay.onSend = (msg, r) => {
    if (msg.type === "cli_auth") r.push({ type: "relay_auth_ok" });
    if (msg.type === "cli_request_job_secrets") {
      r.push({ type: "relay_job_secrets", requestId: msg.requestId, jobId: msg.jobId, ok: true, secrets: opts.secrets ?? secrets() });
    }
    if (msg.type === "cli_runner_register" && opts.dispatch !== false) r.push(runJobMsg());
  };
  return relay;
}

interface Harness {
  runner: CloudRunner;
  relay: FakeRelay;
  jobCtx: () => JobRunnerContext | null;
  jobRunner: RunnerJobRunner & {
    runJob: ReturnType<typeof vi.fn>;
    whenSettled: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  deps: CloudRunnerDeps;
  gitTokens: (string | null)[];
}

function harness(
  relay: FakeRelay,
  over: Partial<CloudRunnerDeps> & { config?: Partial<RunnerConfig>; onRun?: (ctx: JobRunnerContext, msg: RelayRunJobMsg) => void } = {},
): Harness {
  const { config: configOver, onRun, ...depsOver } = over;
  let ctx: JobRunnerContext | null = null;
  const jobRunner = {
    runJob: vi.fn(async (msg: RelayRunJobMsg) => {
      if (ctx) onRun?.(ctx, msg);
      return "session-1";
    }),
    cancelJob: vi.fn(() => true),
    activeJobIds: () => [JOB_ID],
    activeJobCount: () => 1,
    whenSettled: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const gitTokens: (string | null)[] = [];
  const deps: CloudRunnerDeps = {
    config: {
      token: "frt_token",
      relayUrl: "ws://relay",
      jobId: JOB_ID,
      workDir: "/tmp/w",
      timeoutMs: 10_000,
      connectTimeoutMs: 1000,
      secretsTimeoutMs: 1000,
      claimTimeoutMs: 1000,
      heartbeatMs: 60_000,
      ...configOver,
    },
    connect: async () => relay.link(),
    clone: vi.fn(async () => "/tmp/w/web"),
    createJobRunner: (c) => {
      ctx = c;
      return jobRunner;
    },
    registerCheckout: vi.fn(),
    setGitToken: (t) => gitTokens.push(t),
    usage: () => ({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, costUsd: 0.12 }),
    drivers: ["opencode"],
    cliVersion: "1.0.0",
    hostname: "cloud-host",
    log: () => {},
    uuid: () => "req-1",
    ...depsOver,
  };
  return { runner: new CloudRunner(deps), relay, jobCtx: () => ctx, jobRunner, deps, gitTokens };
}

function completeJob(ctx: JobRunnerContext, result: "success" | "failed" = "success"): void {
  ctx.send({
    type: "cli_phase_complete",
    ticketId: "review_1",
    jobId: JOB_ID,
    phase: "pr_review",
    result,
    summary: "done",
  });
}

afterEach(() => vi.useRealTimers());

describe("CloudRunner", () => {
  it("waits for the finished job's cleanup before reporting usage and exiting", async () => {
    const relay = standardRelay();
    const h = harness(relay, { onRun: (ctx) => queueMicrotask(() => completeJob(ctx)) });
    const order: string[] = [];
    let releaseCleanup: () => void = () => {};
    h.jobRunner.whenSettled.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push("cleanup started");
          releaseCleanup = () => {
            order.push("cleanup done");
            resolve();
          };
        }),
    );
    h.jobRunner.dispose.mockImplementation(() => order.push("dispose"));

    let exited = false;
    const done = h.runner.run().then((code) => {
      exited = true;
      return code;
    });
    await vi.waitFor(() => expect(order).toEqual(["cleanup started"]));
    // Cleanup still running: no usage report, no exit.
    expect(relay.ofType("cli_job_usage")).toHaveLength(0);
    expect(exited).toBe(false);

    releaseCleanup();
    expect(await done).toBe(RUNNER_EXIT.OK);
    expect(order).toEqual(["cleanup started", "cleanup done", "dispose"]);
    expect(relay.ofType("cli_job_usage")).toHaveLength(1);
  });

  it("still exits when the job's cleanup throws", async () => {
    const relay = standardRelay();
    const h = harness(relay, { onRun: (ctx) => queueMicrotask(() => completeJob(ctx)) });
    h.jobRunner.whenSettled.mockImplementation(() => {
      throw new Error("cleanup exploded");
    });
    expect(await h.runner.run()).toBe(RUNNER_EXIT.OK);
    expect(relay.ofType("cli_job_usage")).toHaveLength(1);
  });

  it("runs the assigned job end to end and reports usage", async () => {
    const relay = standardRelay();
    const h = harness(relay, { onRun: (ctx) => queueMicrotask(() => completeJob(ctx)) });
    const code = await h.runner.run();

    expect(code).toBe(RUNNER_EXIT.OK);
    expect(relay.ofType("cli_auth")[0].token).toBe("frt_token");
    expect(relay.ofType("cli_request_job_secrets")).toHaveLength(1);
    expect(h.deps.clone).toHaveBeenCalledWith({ repository: "acme/web", token: "ghs_x", dir: "/tmp/w" });

    const reg = relay.ofType("cli_runner_register")[0];
    expect(reg.runner.kind).toBe("cloud");
    expect(reg.runner.repos).toEqual(["github.com/acme/web"]);
    expect(reg.runner.maxConcurrent).toBe(1);

    const ran = h.jobRunner.runJob.mock.calls[0][0] as RelayRunJobMsg;
    expect(ran.ticket.driverName).toBe("opencode");
    expect(ran.ticket.model).toBe("anthropic/claude-x");
    expect(h.deps.registerCheckout).toHaveBeenCalledWith("review_1", "/tmp/w/web", "acme/web");

    const usage = relay.ofType("cli_job_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].usage).toMatchObject({ inputTokens: 100, costUsd: 0.12, model: "anthropic/claude-x" });
    expect(relay.ofType("cli_job_failed")).toHaveLength(0);
    // Git token handed to git, then removed.
    expect(h.gitTokens).toEqual(["ghs_x", null]);
    expect(h.jobRunner.dispose).toHaveBeenCalled();
    // Never sends the provider key anywhere.
    expect(JSON.stringify(relay.sent)).not.toContain("sk-or-secret");
  });

  it("exits with JOB_FAILED when the phase fails", async () => {
    const relay = standardRelay();
    const h = harness(relay, { onRun: (ctx) => queueMicrotask(() => completeJob(ctx, "failed")) });
    expect(await h.runner.run()).toBe(RUNNER_EXIT.JOB_FAILED);
  });

  it("exits AUTH when the token is rejected", async () => {
    const relay = new FakeRelay();
    relay.onSend = (msg, r) => {
      if (msg.type === "cli_auth") r.push({ type: "relay_auth_fail", reason: "Invalid token" });
    };
    const h = harness(relay);
    expect(await h.runner.run()).toBe(RUNNER_EXIT.AUTH);
    expect(relay.ofType("cli_request_job_secrets")).toHaveLength(0);
  });

  it("exits SECRETS when the relay refuses, without cloning", async () => {
    const relay = new FakeRelay();
    relay.onSend = (msg, r) => {
      if (msg.type === "cli_auth") r.push({ type: "relay_auth_ok" });
      if (msg.type === "cli_request_job_secrets") {
        r.push({ type: "relay_job_secrets", requestId: msg.requestId, jobId: msg.jobId, ok: false, error: "already delivered" });
      }
    };
    const h = harness(relay);
    expect(await h.runner.run()).toBe(RUNNER_EXIT.SECRETS);
    expect(h.deps.clone).not.toHaveBeenCalled();
    expect(relay.ofType("cli_request_job_secrets")).toHaveLength(1);
  });

  it("times out waiting for secrets", async () => {
    const relay = new FakeRelay();
    relay.onSend = (msg, r) => {
      if (msg.type === "cli_auth") r.push({ type: "relay_auth_ok" });
    };
    const h = harness(relay, { config: { secretsTimeoutMs: 20 } });
    expect(await h.runner.run()).toBe(RUNNER_EXIT.SECRETS);
  });

  it("exits NO_JOB when the job is never dispatched", async () => {
    const relay = standardRelay({ dispatch: false });
    const h = harness(relay, { config: { claimTimeoutMs: 20 } });
    expect(await h.runner.run()).toBe(RUNNER_EXIT.NO_JOB);
    // Usage is still reported (zero duration) so the ledger closes the job.
    expect(relay.ofType("cli_job_usage")[0].usage.durationMs).toBe(0);
  });

  it("exits on relay disconnect mid-job instead of hanging", async () => {
    const relay = standardRelay();
    const h = harness(relay, { onRun: () => queueMicrotask(() => relay.drop()) });
    expect(await h.runner.run()).toBe(RUNNER_EXIT.DISCONNECTED);
    expect(h.jobRunner.dispose).toHaveBeenCalled();
    expect(h.gitTokens.at(-1)).toBeNull();
  });

  it("enforces the hard timeout and reports the job failed", async () => {
    const relay = standardRelay();
    const h = harness(relay, { config: { timeoutMs: 50 } });
    expect(await h.runner.run()).toBe(RUNNER_EXIT.TIMEOUT);
    const failed = relay.ofType("cli_job_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/hard timeout/);
    expect(relay.ofType("cli_job_usage")).toHaveLength(1);
  });

  it("refuses jobs other than the assigned one", async () => {
    const relay = standardRelay({ dispatch: false });
    relay.onSend = ((orig) => (msg: CliToRelayMsg, r: FakeRelay) => {
      orig(msg, r);
      if (msg.type === "cli_runner_register") {
        r.push(runJobMsg("other_job"));
        r.push(runJobMsg());
      }
    })(relay.onSend);
    const h = harness(relay, { onRun: (ctx) => queueMicrotask(() => completeJob(ctx)) });
    expect(await h.runner.run()).toBe(RUNNER_EXIT.OK);
    expect(h.jobRunner.runJob).toHaveBeenCalledTimes(1);
    expect(relay.ofType("cli_job_failed").map((m) => m.jobId)).toEqual(["other_job"]);
  });

  it("stops when the job is cancelled", async () => {
    const relay = standardRelay();
    const h = harness(relay, {
      onRun: () =>
        queueMicrotask(() => relay.push({ type: "relay_cancel_job", jobId: JOB_ID, ticketId: "review_1", reason: "user" })),
    });
    expect(await h.runner.run()).toBe(RUNNER_EXIT.CANCELLED);
    expect(h.jobRunner.cancelJob).toHaveBeenCalled();
  });

  it("rejects expired secrets", async () => {
    const relay = standardRelay({ secrets: secrets({ expiresAt: Date.now() - 1 }) });
    const h = harness(relay);
    expect(await h.runner.run()).toBe(RUNNER_EXIT.SECRETS);
  });
});
