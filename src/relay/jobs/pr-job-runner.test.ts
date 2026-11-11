import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, JobKind, PrFixInput, PrJobSubject } from "../../contracts/agent-loop.js";
import { TicketPhaseBus } from "../../contracts/ticket-phase-bus.js";
import { ClaudeDriver } from "../../agents/drivers/claude-driver.js";
import type { AgentStatus, BaseDriver, TicketSpawnConfig, TicketSpawnOptions } from "../../agents/drivers/base-driver.js";
import { handleMcpToolCall } from "../../mcp/bridge.js";
import { _clearMcpSessions } from "../../mcp/session-registry.js";
import type { CliToRelayMsg, RelayRunJobMsg } from "../relay-protocol.js";
import { TicketTracker } from "../ticket-tracker.js";
import { JobRunner, type JobAgentSession } from "./job-runner.js";
import { flaioMcpSpawnConfigProvider, flaioTicketWorkspace } from "./ticket-integration.js";
import type { PrJobOptions } from "./pr-job-runner.js";
import { PrJobError } from "../pr-checkout.js";

// ---------------------------------------------------------------------------
// Fakes: the PTY session is faked (as in job-runner.test.ts); git, the ticket
// workspace, the MCP spawn config and the MCP tool endpoint are the real ones.
// The "agent" calls tools through handleMcpToolCall with the token from the
// mcp.json the runner wrote, exactly as `flaio mcp` would.
// ---------------------------------------------------------------------------

class FakeSession extends EventEmitter implements JobAgentSession {
  status: AgentStatus = "idle";
  spawned: { options: Omit<TicketSpawnOptions, "cwd">; env?: Record<string, string>; config: TicketSpawnConfig } | null =
    null;
  closed = false;

  constructor(
    readonly id: string,
    private readonly driver: BaseDriver,
    readonly cwd: string,
    readonly print: boolean,
  ) {
    super();
  }

  async startTicket(options: Omit<TicketSpawnOptions, "cwd">, env?: Record<string, string>) {
    const config = this.driver.buildTicketSpawnArgs({ ...options, cwd: this.cwd });
    this.spawned = { options, env, config };
    this.setStatus("running");
    return config;
  }
  write() {}
  onRawData(listener: (data: string) => void) {
    this.on("raw_data", listener);
    return () => {
      this.off("raw_data", listener);
    };
  }
  setStatus(s: AgentStatus) {
    this.status = s;
    this.emit("status", s);
  }
  exit(code: number) {
    this.status = "exited";
    this.emit("exit", code);
  }
}

// ---- git fixture -----------------------------------------------------------

const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});
afterAll(() => {
  process.env = savedEnv;
});

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let tmp: string;
let bare: string;
let seed: string;
let clone: string;
let headSha: string;

function makeRepos(): void {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flaio-prjobs-")));
  bare = path.join(tmp, "remotes", "acme", "widgets.git");
  fs.mkdirSync(bare, { recursive: true });
  g(bare, "init", "--bare", "-b", "main");
  seed = path.join(tmp, "seed");
  g(tmp, "clone", bare, seed);
  fs.writeFileSync(path.join(seed, "app.ts"), "export const a = 1;\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-m", "init");
  g(seed, "push", "origin", "HEAD:refs/heads/main");
  g(seed, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(seed, "app.ts"), "export const a = 2;\n");
  g(seed, "commit", "-am", "change a");
  g(seed, "push", "origin", "feature");
  headSha = g(seed, "rev-parse", "HEAD");
  g(bare, "update-ref", "refs/pull/7/head", headSha);
  clone = path.join(tmp, "home", "widgets");
  g(tmp, "clone", bare, clone);
}

const worktreesDir = () => path.join(clone, ".flaio", "worktrees");
const prWorktrees = () => (fs.existsSync(worktreesDir()) ? fs.readdirSync(worktreesDir()).filter((n) => n.startsWith("pr-")) : []);

// ---- harness ---------------------------------------------------------------

interface Harness {
  runner: JobRunner;
  sent: CliToRelayMsg[];
  sessions: FakeSession[];
  tracker: TicketTracker;
  bus: TicketPhaseBus;
  ofType<T extends CliToRelayMsg["type"]>(type: T): Extract<CliToRelayMsg, { type: T }>[];
  last(): FakeSession;
  /** Call a Flaio MCP tool as the last agent would. */
  call(tool: string, input: unknown, session?: FakeSession): ReturnType<typeof handleMcpToolCall>;
}

let h: Harness;

function makeHarness(prJobs: PrJobOptions = {}): Harness {
  const driver = new ClaudeDriver();
  const sent: CliToRelayMsg[] = [];
  const sessions: FakeSession[] = [];
  const tracker = new TicketTracker({ filePath: null });
  const bus = new TicketPhaseBus();
  let n = 0;
  const tokens = new WeakMap<FakeSession, string>();
  const runner = new JobRunner({
    send: (m) => sent.push(m),
    resolveCwd: (cwd) => cwd,
    resolveWorktree: async (resolvedCwd) => ({ effectiveCwd: resolvedCwd, worktreePath: null, branchName: "ticket/t1" }),
    getDriver: (name) => (name === "claude" ? driver : undefined),
    createSession: (_driverName, cwd, { print }) => {
      const s = new FakeSession(`session-${++n}`, driver, cwd, print);
      sessions.push(s);
      return s;
    },
    getSession: (id) => sessions.find((s) => s.id === id && !s.closed && s.status !== "exited") ?? null,
    closeSession: (id) => {
      const s = sessions.find((x) => x.id === id);
      if (s && !s.closed) {
        s.closed = true;
        s.setStatus("exited");
        s.removeAllListeners();
      }
    },
    announceSession: () => undefined,
    tracker,
    bus,
    workspace: flaioTicketWorkspace,
    getMcpSpawnConfig: flaioMcpSpawnConfigProvider,
    idleTimeoutMs: () => 60_000,
    idleCheckIntervalMs: 1_000,
    prJobs: { candidateCwds: () => [clone], exitCheckIntervalMs: 50, progressMinIntervalMs: 0, ...prJobs },
  });
  const last = () => sessions[sessions.length - 1] as FakeSession;
  return {
    runner,
    sent,
    sessions,
    tracker,
    bus,
    ofType: (type) => sent.filter((m) => m.type === type) as never,
    last,
    call: (tool, input, session = last()) => {
      // The token as `flaio mcp` holds it (read once: mcp.json is deleted with the job).
      let token = tokens.get(session);
      if (!token) {
        const mcpPath = session.spawned?.options.mcpConfigPath as string;
        token = JSON.parse(fs.readFileSync(mcpPath, "utf-8")).mcpServers.flaio.env.FLAIO_MCP_TOKEN as string;
        tokens.set(session, token);
      }
      return handleMcpToolCall({ token, tool, input }, bus);
    },
  };
}

function subject(over: Partial<PrJobSubject> = {}): PrJobSubject {
  return { type: "pr", owner: "acme", repo: "widgets", number: 7, headSha, headRef: "feature", baseRef: "main", isFork: false, ...over };
}

function prJob(kind: Extract<JobKind, "pr_review" | "pr_fix">, id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    ticketId: "rev1",
    reviewId: "rev1",
    ownerUid: "u1",
    orgId: null,
    kind,
    prompt: null,
    permissionMode: kind === "pr_review" ? "plan" : "acceptEdits",
    status: "claimed",
    runnerId: "runner-a",
    leaseExpiresAt: null,
    attempts: 1,
    maxAttempts: 1,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    subject: subject(),
    ...(kind === "pr_fix" ? { fix: { findingIds: ["f1"], target: "same_branch" } as PrFixInput } : {}),
    ...over,
  };
}

function runMsg(job: Job): RelayRunJobMsg {
  return {
    type: "relay_run_job",
    job,
    ticket: { id: job.ticketId, title: "Change a", cwd: "", useWorktree: true, driverName: "claude", model: null, agentSession: null },
    briefMarkdown: "# Review brief\n\nFocus on app.ts.\n",
    systemInstructions: [],
  };
}

const review = {
  verdict: "needs_fixes",
  summary: "a changed without a test.",
  findings: [{ severity: "medium", confidence: "high", title: "Untested change", path: "app.ts", line: 1, scenario: "Import a." }],
  checkedClean: ["No other files changed."],
};

/** Real git runs behind these waits: give them room on a loaded machine. */
const until = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 20_000, interval: 20 });

const argsOf = (s: FakeSession): string[] => s.spawned?.config.args ?? [];
const flag = (args: string[], f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

beforeEach(() => {
  makeRepos();
  _clearMcpSessions();
  h = makeHarness();
});

afterEach(() => {
  h.runner.dispose();
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("pr_review jobs", () => {
  it("checks out the PR head, runs the agent headless and read-only, and forwards submit_review", async () => {
    const ptyId = await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    expect(ptyId).toBe("session-1");
    const s = h.last();
    const wt = s.cwd;

    // Detached worktree at the PR head under the clone's .flaio/worktrees, with brief and diff.
    expect(wt.startsWith(worktreesDir() + path.sep)).toBe(true);
    expect(g(wt, "rev-parse", "HEAD")).toBe(headSha);
    expect(fs.readFileSync(path.join(wt, ".flaio/ticket/brief.md"), "utf-8")).toContain("Focus on app.ts.");
    expect(fs.readFileSync(path.join(wt, ".flaio/ticket/pr.diff"), "utf-8")).toContain("+export const a = 2;");
    expect(g(clone, "status", "--porcelain")).toBe("");

    // Headless, the job's permission mode, untrusted-workspace isolation, PR tools only.
    expect(s.print).toBe(true);
    const args = argsOf(s);
    expect(args).toContain("-p");
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    // The job's "plan" (read-only) is enforced by tool rules: Claude's plan mode would refuse submit_review.
    expect(flag(args, "--permission-mode")).toBe("default");
    expect(flag(args, "--allowedTools")?.split(",")).toEqual(
      expect.arrayContaining(["Read", "Grep", "mcp__flaio__submit_review", "mcp__flaio__report_progress"]),
    );
    expect(flag(args, "--allowedTools")).not.toMatch(/Bash|Edit|Write|submit_plan|complete_phase/);
    expect(args.at(-1)).toContain("submit_review");
    expect(args.at(-1)).toContain(".flaio/ticket/pr.diff");
    const settings = JSON.parse(fs.readFileSync(flag(args, "--settings") as string, "utf-8"));
    expect(settings.hooks).toBeUndefined();
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash", "Edit", "WebFetch", "Read(~/.config/flaio/**)"]));
    const mcp = JSON.parse(fs.readFileSync(s.spawned?.options.mcpConfigPath as string, "utf-8"));
    expect(mcp.mcpServers.flaio.env.FLAIO_MCP_TOOLSET).toBe("pr_review");
    expect(s.spawned?.env).not.toHaveProperty("FLAIO_MCP_TOKEN");
    expect(s.spawned?.env).toMatchObject({ FLAIO_JOB_ID: "job1", FLAIO_JOB_KIND: "pr_review", FLAIO_REVIEW_ID: "rev1" });

    expect(h.ofType("cli_job_claimed")).toEqual([
      { type: "cli_job_claimed", jobId: "job1", ticketId: "rev1", runnerId: "runner-a", sessionId: "session-1" },
    ]);
    expect(h.runner.activeJobIds()).toEqual(["job1"]);

    // The agent: a ticket tool is refused, progress is forwarded, the review completes the job.
    expect(await h.call("submit_plan", { steps: ["x"], markdown: "x" })).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(await h.call("report_progress", { step: "Read app.ts", status: "done" })).toMatchObject({ ok: true });
    expect(await h.call("submit_review", review)).toMatchObject({ ok: true });

    const events = h.ofType("cli_ticket_event");
    expect(events.at(-1)).toMatchObject({
      ticketId: "rev1",
      jobId: "job1",
      event: { kind: "progress_reported", payload: { step: "Read app.ts", status: "done" } },
    });
    expect(h.ofType("cli_phase_complete")).toEqual([
      {
        type: "cli_phase_complete",
        ticketId: "rev1",
        jobId: "job1",
        phase: "pr_review",
        result: "success",
        summary: review.summary,
        testsRun: [],
        review: { ...review, findings: [{ ...review.findings[0], suggestedFix: null }] },
        gitContext: { headSha },
      },
    ]);
    expect(h.ofType("cli_job_failed")).toEqual([]);
    expect(h.runner.activeJobIds()).toEqual([]);

    // The agent exits: worktree and private refs are removed; tickets are untouched.
    s.exit(0);
    await until(() => {
      expect(prWorktrees()).toEqual([]);
      expect(g(clone, "for-each-ref", "refs/flaio/")).toBe("");
    });
    expect(h.tracker.getAll().size).toBe(0);
    expect(h.tracker.getTrackedProjectCwds()).toEqual([]);
    expect(h.ofType("cli_agent_session")).toEqual([]);
    expect(h.ofType("cli_ticket_status")).toEqual([]);
    // The MCP session is revoked with the job.
    expect(await h.call("report_progress", { step: "late", status: "done" }, s)).toMatchObject({ code: "unauthorized" });
  });

  it("fails the job when the agent exits without calling submit_review", async () => {
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    h.last().emit("raw_data", "\x1b[31mError: model overloaded\x1b[0m\n");
    h.last().exit(1);
    await until(() => expect(prWorktrees()).toEqual([]));
    expect(h.ofType("cli_job_failed")).toEqual([
      expect.objectContaining({
        jobId: "job1",
        ticketId: "rev1",
        error: expect.stringMatching(/exited \(code 1\) without calling submit_review.*model overloaded/),
      }),
    ]);
    expect(h.ofType("cli_phase_complete")).toEqual([]);
  });

  it("accepts a single review: a second submit_review is rejected by the MCP handler", async () => {
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    expect(await h.call("submit_review", { verdict: "nope" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await h.call("submit_review", review)).toMatchObject({ ok: true });
    const second = await h.call("submit_review", { verdict: "approve", summary: "Changed my mind." });
    expect(second).toMatchObject({ ok: false, code: "already_submitted" });
    expect(h.ofType("cli_phase_complete")).toHaveLength(1);
    expect(h.ofType("cli_phase_complete")[0]?.review?.verdict).toBe("needs_fixes");
  });

  it("closes an agent that lingers after submitting", async () => {
    h = makeHarness({ exitGraceMs: 20 });
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    await h.call("submit_review", review);
    await until(() => expect(h.last().closed).toBe(true));
    await until(() => expect(prWorktrees()).toEqual([]));
  });

  it("fails with a head-moved reason (and no agent) when the PR head is not the job's sha", async () => {
    const job = prJob("pr_review", "job1", { subject: subject({ headSha: "0123456789abcdef0123456789abcdef01234567" }) });
    expect(await h.runner.runJob(runMsg(job))).toBeNull();
    expect(h.sessions).toHaveLength(0);
    expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/head moved/);
    expect(prWorktrees()).toEqual([]);
    expect(h.runner.activeJobIds()).toEqual([]);
  });

  it("fails clearly when this runner has no clone of the repository", async () => {
    const job = prJob("pr_review", "job1", { subject: subject({ owner: "acme", repo: "gadgets" }) });
    expect(await h.runner.runJob(runMsg(job))).toBeNull();
    expect(h.ofType("cli_job_failed")).toEqual([
      expect.objectContaining({ jobId: "job1", ticketId: "rev1", error: expect.stringContaining("no checkout of acme/gadgets") }),
    ]);
  });

  it("refuses a PR job without a subject or with a driver that cannot isolate it", async () => {
    const noSubject = prJob("pr_review", "job1", { subject: null });
    expect(await h.runner.runJob(runMsg(noSubject))).toBeNull();
    const msg = runMsg(prJob("pr_review", "job2"));
    msg.ticket.driverName = "gemini";
    expect(await h.runner.runJob(msg)).toBeNull();
    expect(h.ofType("cli_job_failed").map((m) => m.jobId)).toEqual(["job1", "job2"]);
    expect(h.sessions).toHaveLength(0);
  });

  it("cancel stops the agent and removes the worktree, without an end message", async () => {
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    expect(h.runner.cancelJob({ type: "relay_cancel_job", jobId: "job1", ticketId: "rev1", reason: "user" })).toBe(true);
    expect(h.last().closed).toBe(true);
    await until(() => expect(prWorktrees()).toEqual([]));
    expect(h.ofType("cli_job_failed")).toEqual([]);
    expect(h.ofType("cli_phase_complete")).toEqual([]);
    expect(h.runner.activeJobIds()).toEqual([]);
  });

  it("cancel during setup never spawns an agent and leaves no worktree", async () => {
    const pending = h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    expect(h.runner.activeJobIds()).toEqual(["job1"]);
    expect(h.runner.cancelJob({ type: "relay_cancel_job", jobId: "job1", ticketId: "rev1", reason: "user" })).toBe(true);
    expect(await pending).toBeNull();
    await until(() => {
      expect(prWorktrees()).toEqual([]);
      expect(g(clone, "for-each-ref", "refs/flaio/")).toBe("");
    });
    expect(h.sessions).toHaveLength(0);
    expect(h.ofType("cli_job_failed")).toEqual([]);
  });

  it("fails a run that exceeds its time limit and cleans up", async () => {
    h = makeHarness({ timeoutMs: () => 50 });
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    await until(() => expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/timed out/));
    expect(h.last().closed).toBe(true);
    await until(() => expect(prWorktrees()).toEqual([]));
  });

  it("an agent whose PTY vanished without an exit event is detected", async () => {
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    const s = h.last();
    s.closed = true; // gone from the session registry, no events
    await until(() => expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/without calling submit_review/));
    await until(() => expect(prWorktrees()).toEqual([]));
  });

  it("repeated reviews of the same PR do not accumulate worktrees; a newer job supersedes a running one", async () => {
    // A crashed earlier run left a worktree and refs behind.
    await h.runner.runJob(runMsg(prJob("pr_review", "old", { ticketId: "rev0", reviewId: "rev0" })));
    const crashed = h.last().cwd;
    h.runner.dispose(); // (relay shutdown) …
    await until(() => expect(fs.existsSync(crashed)).toBe(false));
    fs.mkdirSync(crashed, { recursive: true }); // … pretend it survived a crash
    h = makeHarness();

    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    const first = h.last();
    expect(fs.existsSync(crashed)).toBe(false);
    await h.runner.runJob(runMsg(prJob("pr_review", "job2", { ticketId: "rev2", reviewId: "rev2" })));
    expect(first.closed).toBe(true);
    expect(h.ofType("cli_job_claimed").map((m) => m.jobId)).toEqual(["job1", "job2"]);
    await until(() => expect(prWorktrees()).toEqual([path.basename(h.last().cwd)]));
    expect(h.ofType("cli_job_failed")).toEqual([]); // superseded, not failed

    await h.call("submit_review", review);
    h.last().exit(0);
    await until(() => expect(prWorktrees()).toEqual([]));
    expect(h.ofType("cli_phase_complete").map((m) => m.jobId)).toEqual(["job2"]);
  });

  it("a duplicate relay_run_job for a running PR job re-claims instead of starting a second agent", async () => {
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    expect(await h.runner.runJob(runMsg(prJob("pr_review", "job1")))).toBe("session-1");
    expect(h.sessions).toHaveLength(1);
    expect(h.ofType("cli_job_claimed")).toHaveLength(2);
    await h.call("submit_review", review);
    // Finished: a re-dispatch of the same attempt gets the same outcome again.
    expect(await h.runner.runJob(runMsg(prJob("pr_review", "job1")))).toBeNull();
    expect(h.ofType("cli_phase_complete")).toHaveLength(2);
    expect(h.sessions).toHaveLength(1);
  });

  it("bounds progress events in rate and size", async () => {
    h = makeHarness({ progressMinIntervalMs: 60_000, progressMaxEvents: 5 });
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    const before = h.ofType("cli_ticket_event").length; // checkout milestones
    for (let i = 0; i < 10; i++) await h.call("report_progress", { step: `step ${i} ${"x".repeat(500)}`, status: "started" });
    await h.call("report_progress", { step: "last", status: "done", note: "n".repeat(2000) });
    const agentEvents = h.ofType("cli_ticket_event").slice(before);
    // One "started" per interval, terminal statuses always pass, and the per-run cap holds.
    expect(agentEvents.map((e) => (e.event.payload as { status: string }).status)).toEqual(["started", "done"]);
    for (const e of agentEvents) {
      const p = e.event.payload as { step: string; note?: string };
      expect(p.step.length).toBeLessThanOrEqual(200);
      expect((p.note ?? "").length).toBeLessThanOrEqual(500);
    }
    expect(h.ofType("cli_ticket_event").length).toBeLessThanOrEqual(5);
  });
});

describe("pr_fix jobs", () => {
  it("same branch: the agent edits, completes, and the runner commits and pushes to the PR branch", async () => {
    await h.runner.runJob(runMsg(prJob("pr_fix", "fix1")));
    const s = h.last();
    const args = argsOf(s);
    expect(flag(args, "--permission-mode")).toBe("acceptEdits");
    expect(args).toContain("--restricted");
    expect(flag(args, "--allowedTools")?.split(",")).toEqual(expect.arrayContaining(["Edit", "Write", "mcp__flaio__complete_phase"]));
    expect(flag(args, "--allowedTools")).not.toMatch(/Bash|submit_review/);
    expect(args.at(-1)).toContain("feature");

    fs.writeFileSync(path.join(s.cwd, "app.ts"), "export const a = 3;\n");
    expect(await h.call("complete_phase", { result: "success", summary: "Guard a against null." })).toMatchObject({ ok: true });
    expect(h.ofType("cli_phase_complete")).toEqual([]); // pushed only after the agent exits
    s.exit(0);

    await until(() => expect(h.ofType("cli_phase_complete")).toHaveLength(1));
    const done = h.ofType("cli_phase_complete")[0];
    const pushed = g(bare, "rev-parse", "refs/heads/feature");
    expect(done).toMatchObject({
      ticketId: "rev1",
      jobId: "fix1",
      phase: "pr_fix",
      result: "success",
      gitContext: { branch: "feature", headSha: pushed },
    });
    expect(done?.summary).toContain(`Pushed 1 commit(s) to feature (${pushed})`);
    expect(g(bare, "log", "-1", "--format=%B", pushed)).toContain("Guard a against null.");
    expect(g(bare, "rev-parse", `${pushed}^`)).toBe(headSha);
    await until(() => expect(prWorktrees()).toEqual([]));
    expect(h.tracker.getAll().size).toBe(0);
  });

  it("new branch: pushes a branch from the PR head and reports it for the server to open the stacked PR", async () => {
    const job = prJob("pr_fix", "fix1", { fix: { findingIds: ["f1"], target: "new_branch", newBranchName: "fix/a" } });
    await h.runner.runJob(runMsg(job));
    fs.writeFileSync(path.join(h.last().cwd, "app.ts"), "export const a = 4;\n");
    await h.call("complete_phase", { result: "success", summary: "Fix a." });
    h.last().exit(0);
    await until(() => expect(h.ofType("cli_phase_complete")).toHaveLength(1));
    const done = h.ofType("cli_phase_complete")[0];
    expect(done?.gitContext).toEqual({ branch: "fix/a", headSha: g(bare, "rev-parse", "refs/heads/fix/a") });
    expect(done?.summary).toMatch(/Flaio opens the stacked pull request from fix\/a into feature/);
    expect(g(bare, "rev-parse", "refs/heads/feature")).toBe(headSha);
  });

  it("new branch that already exists is refused before the agent runs", async () => {
    g(seed, "push", "origin", "main:refs/heads/taken");
    const job = prJob("pr_fix", "fix1", { fix: { findingIds: ["f1"], target: "new_branch", newBranchName: "taken" } });
    expect(await h.runner.runJob(runMsg(job))).toBeNull();
    expect(h.sessions).toHaveLength(0);
    expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/taken already exists/);
    await until(() => expect(prWorktrees()).toEqual([]));
  });

  it("fails with git's message when the push is rejected (the branch moved)", async () => {
    await h.runner.runJob(runMsg(prJob("pr_fix", "fix1")));
    fs.writeFileSync(path.join(h.last().cwd, "app.ts"), "export const a = 5;\n");
    fs.writeFileSync(path.join(seed, "b.ts"), "b\n");
    g(seed, "add", "-A");
    g(seed, "commit", "-m", "concurrent push");
    g(seed, "push", "origin", "feature");
    const moved = g(seed, "rev-parse", "HEAD");
    await h.call("complete_phase", { result: "success", summary: "Fix." });
    h.last().exit(0);
    await until(() => expect(h.ofType("cli_job_failed")).toHaveLength(1));
    expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/Push to origin feature was rejected/);
    expect(g(bare, "rev-parse", "refs/heads/feature")).toBe(moved);
    expect(h.ofType("cli_phase_complete")).toEqual([]);
    await until(() => expect(prWorktrees()).toEqual([]));
  });

  it("refuses same_branch for a fork head without fetching or starting an agent", async () => {
    const job = prJob("pr_fix", "fix1", { subject: subject({ isFork: true }) });
    expect(await h.runner.runJob(runMsg(job))).toBeNull();
    expect(h.sessions).toHaveLength(0);
    expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/fork/);
    expect(g(clone, "for-each-ref", "refs/flaio/")).toBe("");
  });

  it("pushes nothing when the agent exits without complete_phase or reports failure", async () => {
    await h.runner.runJob(runMsg(prJob("pr_fix", "fix1")));
    fs.writeFileSync(path.join(h.last().cwd, "app.ts"), "export const a = 6;\n");
    h.last().exit(0);
    await until(() => expect(h.ofType("cli_job_failed")).toHaveLength(1));
    expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/without calling complete_phase; nothing was pushed/);

    await h.runner.runJob(runMsg(prJob("pr_fix", "fix2")));
    fs.writeFileSync(path.join(h.last().cwd, "app.ts"), "export const a = 7;\n");
    await h.call("complete_phase", { result: "failed", summary: "Finding f1 is not reproducible." });
    h.last().exit(0);
    await until(() => expect(h.ofType("cli_phase_complete")).toHaveLength(1));
    expect(h.ofType("cli_phase_complete")[0]).toMatchObject({ jobId: "fix2", phase: "pr_fix", result: "failed" });
    expect(g(bare, "rev-parse", "refs/heads/feature")).toBe(headSha);
    await until(() => expect(prWorktrees()).toEqual([]));
  });
});

describe("security", () => {
  it("refuses fork fixes for both targets, before fetching", async () => {
    for (const [id, target] of [["f1", "same_branch"], ["f2", "new_branch"]] as const) {
      const job = prJob("pr_fix", id, {
        subject: subject({ isFork: true }),
        fix: { findingIds: ["f1"], target, maintainerCanModify: true, headRepository: "contrib/widgets" },
      });
      expect(await h.runner.runJob(runMsg(job))).toBeNull();
    }
    expect(h.ofType("cli_job_failed").map((m) => m.error)).toEqual([expect.stringMatching(/forks/), expect.stringMatching(/forks/)]);
    expect(h.sessions).toHaveLength(0);
    expect(g(clone, "for-each-ref", "refs/flaio/")).toBe("");
  });

  it("a review-only runner refuses pr_fix before any checkout", async () => {
    h = makeHarness({ reviewOnly: true });
    expect(await h.runner.runJob(runMsg(prJob("pr_fix", "fix1")))).toBeNull();
    expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/review-only/);
    expect(h.sessions).toHaveLength(0);
    expect(g(clone, "for-each-ref", "refs/flaio/")).toBe("");
  });

  it("refuses driver or model values that could be read as flags, and malformed subjects", async () => {
    const m1 = runMsg(prJob("pr_review", "j1"));
    m1.ticket.model = "--dangerously-skip-permissions";
    const m2 = runMsg(prJob("pr_review", "j2"));
    m2.ticket.driverName = "-x";
    const m3 = runMsg(prJob("pr_review", "j3", { subject: subject({ baseRef: "main:refs/heads/x" }) }));
    for (const m of [m1, m2, m3]) expect(await h.runner.runJob(m)).toBeNull();
    expect(h.ofType("cli_job_failed").map((m) => m.jobId)).toEqual(["j1", "j2", "j3"]);
    expect(h.sessions).toHaveLength(0);
    // A ticket job with a flag-like model is refused the same way.
    const t = runMsg({ ...prJob("pr_review", "t1"), kind: "implement", subject: null, ticketId: "ticket1" } as Job);
    t.ticket = { ...t.ticket, id: "ticket1", cwd: clone, model: "--evil" };
    expect(await h.runner.runJob(t)).toBeNull();
    expect(h.ofType("cli_job_failed").at(-1)).toMatchObject({ jobId: "t1", error: expect.stringMatching(/invalid model/) });
  });

  it("refuses to review blind when no diff against the base can be produced", async () => {
    const job = prJob("pr_review", "job1", { subject: subject({ baseRef: "no-such-branch" }) });
    expect(await h.runner.runJob(runMsg(job))).toBeNull();
    expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/Could not compute the pull request's diff against no-such-branch/);
    expect(h.sessions).toHaveLength(0);
    await until(() => expect(prWorktrees()).toEqual([]));
  });

  it("refuses pr_fix with a driver that has no safe untrusted edit mode", async () => {
    const driver = new ClaudeDriver();
    Object.defineProperty(driver, "ticketCapabilities", { value: { ...driver.ticketCapabilities, untrustedWorkspaceEdits: false } });
    const runner = new JobRunner({
      send: (m) => h.sent.push(m),
      resolveCwd: (c) => c,
      resolveWorktree: async (c) => ({ effectiveCwd: c, worktreePath: null, branchName: null }),
      getDriver: () => driver,
      createSession: () => null,
      getSession: () => null,
      closeSession: () => undefined,
      announceSession: () => undefined,
      tracker: h.tracker,
      bus: new TicketPhaseBus(),
      workspace: flaioTicketWorkspace,
      getMcpSpawnConfig: flaioMcpSpawnConfigProvider,
      prJobs: { candidateCwds: () => [clone] },
    });
    expect(await runner.runJob(runMsg(prJob("pr_fix", "fix1")))).toBeNull();
    expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/can only review/);
    runner.dispose();
  });

  it("passes readOnly to the driver for reviews only", async () => {
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    expect(h.last().spawned?.options).toMatchObject({ untrustedWorkspace: true, readOnly: true });
  });

  it("reports the changed files with line counts in the completion summary", async () => {
    await h.runner.runJob(runMsg(prJob("pr_fix", "fix1")));
    fs.writeFileSync(path.join(h.last().cwd, "app.ts"), "export const a = 3;\nexport const b = 4;\n");
    await h.call("complete_phase", { result: "success", summary: "Fix a." });
    h.last().exit(0);
    await until(() => expect(h.ofType("cli_phase_complete")).toHaveLength(1));
    expect(h.ofType("cli_phase_complete")[0]?.summary).toContain("Changed 1 file(s), +2 -1:\n- app.ts (+2 -1)");
  });

  it("refuses a fix touching a workflow file and pushes nothing", async () => {
    await h.runner.runJob(runMsg(prJob("pr_fix", "fix1")));
    const wt = h.last().cwd;
    fs.mkdirSync(path.join(wt, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".github", "workflows", "x.yml"), "on: push\n");
    await h.call("complete_phase", { result: "success", summary: "Fix." });
    h.last().exit(0);
    await until(() => expect(h.ofType("cli_job_failed")).toHaveLength(1));
    expect(h.ofType("cli_job_failed")[0]?.error).toMatch(/protected CI .* \.github\/workflows\/x\.yml/);
    expect(g(bare, "rev-parse", "refs/heads/feature")).toBe(headSha);
  });

  it("cancel while pushing aborts the push, waits for it before removing the worktree, and says what happened", async () => {
    let signal: AbortSignal | undefined;
    let settled = false;
    h = makeHarness({
      ops: {
        finishFix: (_co, _s, _f, o) =>
          new Promise((_resolve, reject) => {
            signal = o.signal;
            o.signal?.addEventListener("abort", () =>
              setTimeout(() => {
                settled = true;
                reject(new PrJobError("cancelled", "Cancelled while pushing; the push was stopped and feature was not updated.", false));
              }, 200),
            );
          }),
      },
    });
    await h.runner.runJob(runMsg(prJob("pr_fix", "fix1")));
    fs.writeFileSync(path.join(h.last().cwd, "app.ts"), "export const a = 9;\n");
    await h.call("complete_phase", { result: "success", summary: "Fix." });
    h.last().exit(0);
    await until(() => expect(signal).toBeDefined());
    expect(h.runner.cancelJob({ type: "relay_cancel_job", jobId: "fix1", ticketId: "rev1", reason: "user" })).toBe(true);
    expect(signal?.aborted).toBe(true);
    // The worktree stays until the aborted push settled.
    expect(prWorktrees()).toHaveLength(1);
    await until(() => expect(prWorktrees()).toEqual([]));
    expect(settled).toBe(true);
    const note = h.ofType("cli_ticket_event").at(-1);
    expect(note?.event.payload).toMatchObject({ step: "Pushing fixes", status: "failed", note: expect.stringMatching(/not updated/) });
    expect(h.ofType("cli_phase_complete")).toEqual([]);
    expect(h.ofType("cli_job_failed")).toEqual([]);
  });
});

describe("ticket jobs next to PR jobs", () => {
  it("ticket MCP events still take the ticket path while a PR job runs", async () => {
    await h.runner.runJob(runMsg(prJob("pr_review", "job1")));
    h.bus.emitEvent("progress", { ticketId: "t1", jobId: null, progress: { step: "ticket step", status: "done" } });
    expect(h.ofType("cli_ticket_event").at(-1)).toMatchObject({ ticketId: "t1", event: { payload: { step: "ticket step" } } });
    // A review event for a PR id never reaches the ticket path (no plan/question forwarding).
    h.bus.emitEvent("question", { ticketId: "rev1", jobId: "job1", questionId: "q1", question: { text: "?", blocking: true } });
    expect(h.ofType("cli_ticket_event").filter((e) => e.event.kind === "question_asked")).toEqual([]);
    expect(h.runner.isTicketBusy("rev1")).toBe(false);
  });
});
