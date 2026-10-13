import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Job, JobKind, TicketAgentSession } from "../../contracts/agent-loop.js";
import { TicketPhaseBus } from "../../contracts/ticket-phase-bus.js";
import { ClaudeDriver } from "../../agents/drivers/claude-driver.js";
import type { AgentStatus, BaseDriver, TicketSpawnConfig, TicketSpawnOptions } from "../../agents/drivers/base-driver.js";
import type { CliToRelayMsg, RelayRunJobMsg } from "../relay-protocol.js";
import { TicketTracker } from "../ticket-tracker.js";
import { JobRunner, type JobAgentSession } from "./job-runner.js";
import {
  mapRequestChanges,
  mapStartImplementation,
  mapStartInteractivePlanning,
  mapStartPlanning,
} from "./legacy-mapper.js";

// ---------------------------------------------------------------------------
// Fakes (no node-pty, no real agent)
// ---------------------------------------------------------------------------

class FakeSession extends EventEmitter implements JobAgentSession {
  status: AgentStatus = "idle";
  spawned: { options: Omit<TicketSpawnOptions, "cwd">; env?: Record<string, string>; config: TicketSpawnConfig } | null =
    null;
  written: string[] = [];
  closed = false;

  constructor(
    readonly id: string,
    private readonly driver: BaseDriver,
    readonly cwd: string,
  ) {
    super();
  }

  async startTicket(options: Omit<TicketSpawnOptions, "cwd">, env?: Record<string, string>) {
    const config = this.driver.buildTicketSpawnArgs({ ...options, cwd: this.cwd });
    this.spawned = { options, env, config };
    this.setStatus("running");
    return config;
  }
  write(data: string) {
    this.written.push(data);
  }
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

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

interface Harness {
  runner: JobRunner;
  sent: CliToRelayMsg[];
  sessions: FakeSession[];
  tracker: TicketTracker;
  bus: TicketPhaseBus;
  clock: { now: number };
  mcpCalls: [string, string][];
  ofType<T extends CliToRelayMsg["type"]>(type: T): Extract<CliToRelayMsg, { type: T }>[];
  last(): FakeSession;
}

let tmp: string;
let harness: Harness;

function makeHarness(opts: { mcpPath?: string } = {}): Harness {
  const driver = new ClaudeDriver();
  const sent: CliToRelayMsg[] = [];
  const sessions: FakeSession[] = [];
  const tracker = new TicketTracker({ filePath: null });
  const bus = new TicketPhaseBus();
  const clock = { now: 1_000_000 };
  const mcpCalls: [string, string][] = [];
  let uuidIdx = 0;
  let sessionIdx = 0;

  const runner = new JobRunner({
    send: (m) => sent.push(m),
    resolveCwd: (cwd) => cwd,
    resolveWorktree: async (resolvedCwd) => ({ effectiveCwd: resolvedCwd, worktreePath: null, branchName: "ticket/t1" }),
    getDriver: (name) => (name === "claude" ? driver : undefined),
    createSession: (_driverName, cwd) => {
      const s = new FakeSession(`session-${++sessionIdx}`, driver, cwd);
      sessions.push(s);
      return s;
    },
    getSession: (id) => sessions.find((s) => s.id === id && !s.closed && s.status !== "exited") ?? null,
    // Mirrors appStore.closeSession → AgentSession.kill(): status "exited" is
    // emitted, then every listener is dropped — no "exit" event.
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
    getMcpSpawnConfig: (ticketId, jobId) => {
      mcpCalls.push([ticketId, jobId]);
      return opts.mcpPath ? { mcpConfigPath: opts.mcpPath, env: { FLAIO_MCP: "1" } } : undefined;
    },
    idleTimeoutMs: () => 60_000,
    idleCheckIntervalMs: 1_000,
    now: () => clock.now,
    uuid: () => UUIDS[uuidIdx++] ?? `uuid-${uuidIdx}`,
  });

  return {
    runner,
    sent,
    sessions,
    tracker,
    bus,
    clock,
    mcpCalls,
    ofType: (type) => sent.filter((m) => m.type === type) as never,
    last: () => sessions[sessions.length - 1] as FakeSession,
  };
}

function job(kind: JobKind, id: string, permissionMode: Job["permissionMode"], prompt: string | null = null): Job {
  return {
    id,
    ticketId: "t1",
    ownerUid: "u1",
    orgId: null,
    kind,
    prompt,
    permissionMode,
    status: "claimed",
    runnerId: "runner-a",
    leaseExpiresAt: null,
    attempts: 1,
    maxAttempts: 3,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function runJobMsg(j: Job, agentSession: TicketAgentSession | null, brief = "# Brief\n"): RelayRunJobMsg {
  return {
    type: "relay_run_job",
    job: j,
    ticket: { id: "t1", title: "Fix login", cwd: tmp, useWorktree: true, driverName: "claude", model: null, agentSession },
    briefMarkdown: brief,
    systemInstructions: ["Use pnpm."],
  };
}

const argsOf = (s: FakeSession): string[] => s.spawned?.config.args ?? [];

const flag = (args: string[], f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flaio-jobs-"));
  harness = makeHarness({ mcpPath: "/tmp/flaio-mcp.json" });
});

afterEach(async () => {
  harness.runner.dispose();
  vi.useRealTimers();
  await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// relay_run_job
// ---------------------------------------------------------------------------

describe("JobRunner.runJob", () => {
  it("first run: writes the brief, presets a session id, claims the job and reports the agent session", async () => {
    const h = harness;
    const ptyId = await h.runner.runJob(runJobMsg(job("plan", "job1", "plan"), null, "# Brief one"));
    expect(ptyId).toBe("session-1");

    expect(await fs.readFile(path.join(tmp, ".flaio/ticket/brief.md"), "utf-8")).toBe("# Brief one\n");
    expect(h.mcpCalls).toEqual([["t1", "job1"]]);

    const s = h.last();
    const args = argsOf(s);
    expect(flag(args, "--session-id")).toBe(UUIDS[0]);
    expect(args).not.toContain("--resume");
    expect(flag(args, "--permission-mode")).toBe("plan");
    expect(flag(args, "--mcp-config")).toBe("/tmp/flaio-mcp.json");
    expect(flag(args, "--append-system-prompt")).toBe("Use pnpm.");
    expect(args.at(-1)).toContain(".flaio/ticket/brief.md");
    expect(args.at(-1)).toContain("submit_plan");
    expect(s.spawned?.env).toMatchObject({ FLAIO_TICKET_ID: "t1", FLAIO_JOB_ID: "job1", FLAIO_MCP: "1" });

    expect(h.ofType("cli_job_claimed")).toEqual([
      { type: "cli_job_claimed", jobId: "job1", ticketId: "t1", runnerId: "runner-a", sessionId: "session-1" },
    ]);
    const [agent] = h.ofType("cli_agent_session");
    expect(agent?.agentSession).toEqual({ id: UUIDS[0], driver: "claude", runnerId: "runner-a", resumeCount: 0 });
    expect(h.tracker.getAgentSession("t1")?.id).toBe(UUIDS[0]);
    // No legacy messages for job-path runs.
    expect(h.ofType("cli_ticket_status")).toEqual([]);
  });

  it("later jobs resume the SAME session id and bump resumeCount", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("plan", "job1", "plan"), null));
    const first = h.ofType("cli_agent_session")[0]?.agentSession;

    await h.runner.runJob(runJobMsg(job("implement", "job2", "acceptEdits"), first));
    // The planning agent is superseded (closed) before the implementation resumes.
    expect(h.sessions[0]?.closed).toBe(true);

    const args = argsOf(h.last());
    expect(flag(args, "--resume")).toBe(UUIDS[0]);
    expect(args).not.toContain("--session-id");
    expect(flag(args, "--permission-mode")).toBe("acceptEdits");

    const sessions = h.ofType("cli_agent_session").map((m) => m.agentSession);
    expect(sessions.at(-1)).toMatchObject({ id: UUIDS[0], resumeCount: 1, lastResumedAt: h.clock.now });
    // The superseded job must not be reported as failed.
    expect(h.ofType("cli_job_failed")).toEqual([]);
  });

  it("falls back to the locally tracked session when the server sends none for a resume kind", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("plan", "job1", "plan"), null));
    await h.runner.runJob(runJobMsg(job("review_fixes", "job2", "acceptEdits", "Rename foo"), null));
    const args = argsOf(h.last());
    expect(flag(args, "--resume")).toBe(UUIDS[0]);
    expect(args.at(-1)).toContain("Rename foo");
  });

  it("starts fresh when the session belongs to another runner", async () => {
    const h = harness;
    const foreign: TicketAgentSession = { id: "aaaa", driver: "claude", runnerId: "runner-b", resumeCount: 3 };
    await h.runner.runJob(runJobMsg(job("implement", "job2", "acceptEdits"), foreign));
    const args = argsOf(h.last());
    expect(args).not.toContain("--resume");
    expect(flag(args, "--session-id")).toBe(UUIDS[0]);
    expect(args.at(-1)).toContain("another session");
  });

  it("retries as a fresh session when a resume fails immediately", async () => {
    const h = harness;
    const prev: TicketAgentSession = { id: UUIDS[2] as string, driver: "claude", runnerId: "runner-a", resumeCount: 0 };
    await h.runner.runJob(runJobMsg(job("implement", "job2", "acceptEdits"), prev));
    expect(flag(argsOf(h.last()), "--resume")).toBe(UUIDS[2]);

    h.clock.now += 2_000;
    h.last().exit(1); // e.g. "No conversation found with session ID"
    await vi.waitFor(() => expect(h.sessions).toHaveLength(2));

    const args = argsOf(h.last());
    expect(args).not.toContain("--resume");
    expect(flag(args, "--session-id")).toBe(UUIDS[0]);
    expect(h.ofType("cli_job_failed")).toEqual([]);
    expect(h.ofType("cli_agent_session").at(-1)?.agentSession).toMatchObject({ id: UUIDS[0], resumeCount: 0 });
  });

  it("reports cli_job_failed when the agent exits before complete_phase", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("plan", "job1", "plan"), null));
    h.clock.now += 60_000;
    h.last().exit(0);
    expect(h.ofType("cli_job_failed")).toEqual([
      expect.objectContaining({ jobId: "job1", ticketId: "t1", error: expect.stringContaining("before calling complete_phase") }),
    ]);
    expect(h.ofType("cli_job_failed")[0]?.stuck).toBeUndefined();
  });

  it("reports start failures for unknown drivers", async () => {
    const h = harness;
    const msg = runJobMsg(job("plan", "job1", "plan"), null);
    msg.ticket.driverName = "nope";
    expect(await h.runner.runJob(msg)).toBeNull();
    expect(h.ofType("cli_job_failed")[0]).toMatchObject({ jobId: "job1", error: expect.stringContaining("nope") });
  });

  it("updates the transcript path from sideband metadata", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("plan", "job1", "plan"), null));
    h.last().emit("agent_session_info", { agentSessionId: UUIDS[0], transcriptPath: "/home/u/.claude/projects/x/1.jsonl" });
    h.last().emit("agent_session_info", { agentSessionId: UUIDS[0], transcriptPath: "/home/u/.claude/projects/x/1.jsonl" });
    const reports = h.ofType("cli_agent_session");
    expect(reports).toHaveLength(2);
    expect(reports[1]?.agentSession).toMatchObject({ id: UUIDS[0], transcriptPath: "/home/u/.claude/projects/x/1.jsonl" });
    expect(h.tracker.getAgentSession("t1")?.transcriptPath).toBe("/home/u/.claude/projects/x/1.jsonl");
  });

  it("cancels a running job", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("implement", "job1", "acceptEdits"), null));
    expect(h.runner.cancelJob({ type: "relay_cancel_job", jobId: "job1", ticketId: "t1", reason: "user" })).toBe(true);
    expect(h.last().closed).toBe(true);
    expect(h.ofType("cli_job_failed")).toEqual([]);
    expect(h.tracker.get("t1")?.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Phase bus forwarding + idle watchdog
// ---------------------------------------------------------------------------

describe("TicketPhaseBus forwarding", () => {
  const plan = { steps: ["a", "b"], risks: ["r"], files: ["src/x.ts"], markdown: "# Plan" };

  it("forwards plan/question/decision/progress as cli_ticket_event and complete_phase as cli_phase_complete", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("plan", "job1", "plan"), null));

    h.bus.emitEvent("plan_submitted", { ticketId: "t1", jobId: "job1", plan });
    h.bus.emitEvent("question", { ticketId: "t1", jobId: "job1", questionId: "q1", question: { text: "Which DB?", blocking: false } });
    h.bus.emitEvent("decision", { ticketId: "t1", jobId: null, decision: { title: "Use zod", rationale: "Already a dep" } });
    h.bus.emitEvent("progress", { ticketId: "t1", jobId: "job1", progress: { step: "a", status: "done" } });

    const events = h.ofType("cli_ticket_event");
    expect(events.map((e) => e.event.kind)).toEqual([
      "plan_submitted",
      "question_asked",
      "decision_recorded",
      "progress_reported",
    ]);
    expect(events.every((e) => e.jobId === "job1" && e.ticketId === "t1")).toBe(true);
    expect(events[0]?.event.payload).toEqual({ ...plan, iteration: 0 });
    expect(events[0]?.event.actor).toMatchObject({ type: "agent", id: UUIDS[0] });
    expect(events[1]?.event.payload).toEqual({ questionId: "q1", text: "Which DB?", blocking: false });

    h.bus.emitEvent("phase_complete", {
      ticketId: "t1",
      jobId: "job1",
      completion: { result: "success", summary: "Planned", testsRun: [] },
    });
    expect(h.ofType("cli_phase_complete")).toEqual([
      {
        type: "cli_phase_complete",
        ticketId: "t1",
        jobId: "job1",
        phase: "plan",
        result: "success",
        summary: "Planned",
        testsRun: [],
        plan,
        gitContext: { branch: "ticket/t1" },
      },
    ]);
    expect(h.ofType("cli_ticket_event").at(-1)?.event.kind).toBe("phase_completed");

    // Completion is final: a later exit is not a failure.
    h.last().exit(0);
    expect(h.ofType("cli_job_failed")).toEqual([]);
  });

  it("ignores completions for a stale job id", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("implement", "job2", "acceptEdits"), null));
    h.bus.emitEvent("phase_complete", {
      ticketId: "t1",
      jobId: "job-old",
      completion: { result: "success", summary: "old", testsRun: [] },
    });
    const complete = h.ofType("cli_phase_complete");
    // Forwarded under its own job id, but the running job is still active.
    expect(complete.map((c) => c.jobId)).toEqual(["job-old"]);
    h.clock.now += 60_000;
    h.last().exit(1);
    expect(h.ofType("cli_job_failed").map((f) => f.jobId)).toEqual(["job2"]);
  });

  it("idle detection only reports stuck after the configured timeout — never done", async () => {
    vi.useFakeTimers();
    const h = harness;
    await h.runner.runJob(runJobMsg(job("implement", "job1", "acceptEdits"), null));
    h.last().setStatus("waiting_input");

    h.clock.now += 30_000;
    vi.advanceTimersByTime(1_000);
    expect(h.ofType("cli_job_failed")).toEqual([]);

    h.clock.now += 31_000;
    vi.advanceTimersByTime(1_000);
    expect(h.ofType("cli_job_failed")).toEqual([
      expect.objectContaining({ jobId: "job1", stuck: true, error: expect.stringContaining("idle") }),
    ]);

    // Reported once only; never a completion.
    h.clock.now += 120_000;
    vi.advanceTimersByTime(5_000);
    expect(h.ofType("cli_job_failed")).toHaveLength(1);
    expect(h.ofType("cli_phase_complete")).toEqual([]);
    expect(h.ofType("cli_implementation_done")).toEqual([]);
    expect(h.tracker.get("t1")?.status).toBe("stuck");
  });

  it("bus activity resets the idle clock", async () => {
    vi.useFakeTimers();
    const h = harness;
    await h.runner.runJob(runJobMsg(job("implement", "job1", "acceptEdits"), null));
    h.last().setStatus("waiting_input");
    h.clock.now += 50_000;
    h.bus.emitEvent("progress", { ticketId: "t1", jobId: "job1", progress: { step: "x", status: "started" } });
    h.clock.now += 50_000;
    vi.advanceTimersByTime(1_000);
    expect(h.ofType("cli_job_failed")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Legacy messages → job path
// ---------------------------------------------------------------------------

describe("legacy → job mapping", () => {
  const planningMsg = {
    type: "relay_start_planning" as const,
    ticketId: "t1",
    ticketTitle: "Fix login",
    ticketDescription: "Users cannot log in",
    systemInstructions: ["x"],
    cwd: "",
  };

  it("maps legacy messages to job kinds and permission modes", () => {
    const now = 42;
    const p = mapStartPlanning({ ...planningMsg, cwd: "/r" }, undefined, ["i"], now);
    expect(p.msg.job).toMatchObject({ kind: "plan", permissionMode: "default", ticketId: "t1" });
    expect(p.msg.job.id.startsWith("legacy-")).toBe(true);
    expect(p.options).toMatchObject({ print: true, legacy: { mode: "planning_print", iteration: 0 } });
    expect(p.msg.briefMarkdown).toContain("Users cannot log in");

    const rev = mapStartPlanning(
      { ...planningMsg, cwd: "/r", previousPlan: "old", feedback: "more tests", iteration: 2 },
      { sessionId: null, status: "plan_ready", ticketTitle: "", originalCwd: "/r", worktreePath: null, branchName: null, agentSession: { id: "A", driver: "claude", resumeCount: 0 } },
      [],
      now,
    );
    expect(rev.msg.job.kind).toBe("revise_plan");
    expect(rev.msg.ticket.agentSession?.id).toBe("A");
    expect(rev.options.legacy).toEqual({ mode: "planning_print", iteration: 2, feedback: "more tests" });

    const ip = mapStartInteractivePlanning({ ...planningMsg, type: "relay_start_interactive_planning", cwd: "/r" }, undefined, [], now);
    expect(ip.msg.job).toMatchObject({ kind: "plan", permissionMode: "plan" });
    expect(ip.options.print).toBeUndefined();

    const impl = mapStartImplementation(
      { type: "relay_start_implementation", ticketId: "t1", plan: "P", systemInstructions: [], cwd: "/r" },
      { sessionId: null, status: "plan_ready", ticketTitle: "Fix login", originalCwd: "/r", worktreePath: null, branchName: null, agentSession: { id: "A", driver: "claude", resumeCount: 0 } },
      [],
      now,
    );
    expect(impl.msg.job).toMatchObject({ kind: "implement", permissionMode: "acceptEdits" });
    expect(impl.msg.ticket.agentSession?.id).toBe("A");
    expect(impl.msg.briefMarkdown).toContain("P");

    const entryBase = { sessionId: null, ticketTitle: "T", originalCwd: "/r", worktreePath: "/r/wt", branchName: "b" };
    const rcPlan = mapRequestChanges(
      { type: "relay_request_changes", ticketId: "t1", sessionId: "s", feedback: "F" },
      { ...entryBase, status: "plan_ready", lastJobKind: "plan" },
      now,
    );
    expect(rcPlan?.msg.job).toMatchObject({ kind: "revise_plan", permissionMode: "plan", prompt: "F" });
    expect(rcPlan?.msg.ticket.useWorktree).toBe(true);
    const rcImpl = mapRequestChanges(
      { type: "relay_request_changes", ticketId: "t1", sessionId: "s", feedback: "F" },
      { ...entryBase, status: "done", lastJobKind: "implement" },
      now,
    );
    expect(rcImpl?.msg.job).toMatchObject({ kind: "review_fixes", permissionMode: "acceptEdits" });
    expect(rcImpl?.options.briefMode).toBe("append");
    expect(mapRequestChanges({ type: "relay_request_changes", ticketId: "t1", sessionId: "s", feedback: "F" }, undefined, now)).toBeNull();
  });

  it("planning → implementation → request_changes all run in ONE agent session", async () => {
    const h = makeHarness(); // no MCP yet: legacy fallbacks must still work
    harness.runner.dispose();
    harness = h;

    // 1. Legacy print-mode planning: stdout captured as the plan on exit.
    const p = mapStartPlanning({ ...planningMsg, cwd: tmp }, h.tracker.get("t1"), ["Org rule"], 1);
    await h.runner.runJob(p.msg, p.options);
    const planning = h.last();
    const planArgs = argsOf(planning);
    expect(planArgs).toContain("-p");
    expect(flag(planArgs, "--session-id")).toBe(UUIDS[0]);
    expect(flag(planArgs, "--allowedTools")).toBe("Read,Glob,Grep,Bash(git *)");
    expect(planArgs.at(-1)).toContain("Output ONLY the complete plan");
    expect(h.ofType("cli_job_claimed")).toEqual([]);
    expect(h.ofType("cli_ticket_status").map((m) => m.status)).toEqual(["planning"]);

    planning.emit("raw_data", "\u001b[1mStep 1\u001b[0m: do it\n");
    planning.exit(0);
    expect(h.ofType("cli_plan_ready")).toEqual([
      expect.objectContaining({ ticketId: "t1", sessionId: planning.id, plan: "Step 1: do it", iteration: 0, feedback: null }),
    ]);
    expect(h.ofType("cli_ticket_status").map((m) => m.status)).toEqual(["planning", "plan_ready"]);

    // 2. Legacy implementation resumes the planning session.
    const impl = mapStartImplementation(
      { type: "relay_start_implementation", ticketId: "t1", plan: "Step 1: do it", systemInstructions: [], cwd: tmp },
      h.tracker.get("t1"),
      [],
      2,
    );
    await h.runner.runJob(impl.msg, impl.options);
    const implementing = h.last();
    const implArgs = argsOf(implementing);
    expect(flag(implArgs, "--resume")).toBe(UUIDS[0]);
    expect(flag(implArgs, "--permission-mode")).toBe("acceptEdits");
    expect(implArgs.at(-1)).toContain("The plan has been approved");
    expect(h.ofType("cli_ticket_status").at(-1)?.status).toBe("implementing");

    // complete_phase (once A2's MCP is attached) → legacy cli_implementation_done.
    h.bus.emitEvent("phase_complete", {
      ticketId: "t1",
      jobId: impl.msg.job.id,
      completion: { result: "success", summary: "Implemented login fix", testsRun: ["npm test"] },
    });
    expect(h.ofType("cli_implementation_done")).toEqual([
      expect.objectContaining({ ticketId: "t1", summary: "Implemented login fix", gitContext: { branch: "ticket/t1" } }),
    ]);
    expect(h.ofType("cli_ticket_status").at(-1)?.status).toBe("done");
    // Legacy runs never leak synthetic job ids or job-protocol completions.
    expect(h.ofType("cli_phase_complete")).toEqual([]);
    expect(h.ofType("cli_ticket_event").every((e) => e.jobId === null)).toBe(true);

    // 3. While the agent is alive, request_changes types into it.
    expect(await h.runner.requestChanges({ type: "relay_request_changes", ticketId: "t1", sessionId: implementing.id, feedback: "Add a test" })).toBe("written");
    expect(implementing.written).toEqual(["Add a test\n"]);

    // 4. After the PTY is gone, request_changes resumes the same session instead of being dropped.
    implementing.exit(0);
    expect(await h.runner.requestChanges({ type: "relay_request_changes", ticketId: "t1", sessionId: implementing.id, feedback: "Rename the helper" })).toBe("resumed");
    const fixes = h.last();
    expect(fixes).not.toBe(implementing);
    expect(flag(argsOf(fixes), "--resume")).toBe(UUIDS[0]);
    expect(argsOf(fixes).at(-1)).toContain("Rename the helper");
    const brief = await fs.readFile(path.join(tmp, ".flaio/ticket/brief.md"), "utf-8");
    expect(brief).toContain("Step 1: do it");
    expect(brief).toContain("Rename the helper");

    const agentSessions = h.ofType("cli_agent_session").map((m) => m.agentSession);
    expect(new Set(agentSessions.map((s) => s.id))).toEqual(new Set([UUIDS[0]]));
    expect(agentSessions.at(-1)?.resumeCount).toBe(2);
  });

  it("legacy planning prefers a submitted plan over stdout", async () => {
    const h = harness;
    const p = mapStartPlanning({ ...planningMsg, cwd: tmp }, undefined, [], 1);
    await h.runner.runJob(p.msg, p.options);
    h.last().emit("raw_data", "noise");
    h.bus.emitEvent("plan_submitted", {
      ticketId: "t1",
      jobId: p.msg.job.id,
      plan: { steps: ["s"], risks: [], files: [], markdown: "# Structured plan" },
    });
    h.last().exit(0);
    expect(h.ofType("cli_plan_ready")[0]?.plan).toBe("# Structured plan");
  });

  it("legacy idle only annotates the status, never marks done", async () => {
    vi.useFakeTimers();
    const h = harness;
    const impl = mapStartImplementation(
      { type: "relay_start_implementation", ticketId: "t1", plan: "P", systemInstructions: [], cwd: tmp },
      undefined,
      [],
      1,
    );
    await h.runner.runJob(impl.msg, impl.options);
    h.last().setStatus("waiting_input");
    h.clock.now += 61_000;
    vi.advanceTimersByTime(1_000);
    const last = h.ofType("cli_ticket_status").at(-1);
    expect(last).toMatchObject({ status: "implementing", message: expect.stringContaining("idle") });
    expect(h.ofType("cli_implementation_done")).toEqual([]);
    expect(h.ofType("cli_job_failed")).toEqual([]);
  });

  it("request_changes for an unknown ticket reports an error instead of dropping silently", async () => {
    const h = harness;
    expect(await h.runner.requestChanges({ type: "relay_request_changes", ticketId: "zz", sessionId: "s", feedback: "F" })).toBe("unknown");
    expect(h.ofType("cli_ticket_status")[0]).toMatchObject({ ticketId: "zz", status: "error" });
  });
});

// ---------------------------------------------------------------------------
// Concurrency and session teardown
// ---------------------------------------------------------------------------

/** What appStore.closeSession does to a live session: status "exited", then all listeners dropped. */
function userCloses(s: FakeSession): void {
  s.closed = true;
  s.setStatus("exited");
  s.removeAllListeners();
}

const tick = () => new Promise((r) => setImmediate(r));

describe("JobRunner concurrency", () => {
  it("two jobs for one ticket arriving together spawn only the newer one", async () => {
    const h = harness;
    const first = h.runner.runJob(runJobMsg(job("plan", "job1", "plan"), null));
    const second = h.runner.runJob(runJobMsg(job("revise_plan", "job2", "plan"), null));
    expect(await first).toBeNull();
    expect(await second).toBe("session-1");

    expect(h.sessions).toHaveLength(1);
    expect(h.last().spawned?.env?.FLAIO_JOB_ID).toBe("job2");
    expect(h.ofType("cli_job_claimed").map((m) => m.jobId)).toEqual(["job2"]);
    expect(h.ofType("cli_job_failed")).toEqual([]);
    expect(h.runner.getActiveSessionId("t1")).toBe("session-1");
  });

  it("cancelling a job that is still setting up keeps it from spawning", async () => {
    const h = harness;
    const pending = h.runner.runJob(runJobMsg(job("implement", "job1", "acceptEdits"), null));
    expect(h.runner.cancelJob({ type: "relay_cancel_job", jobId: "job1", ticketId: "t1", reason: "user" })).toBe(true);
    expect(await pending).toBeNull();
    expect(h.sessions).toHaveLength(0);
    expect(h.ofType("cli_job_claimed")).toEqual([]);
  });

  it("cancel drops the run and the ticket's PTY mapping", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("implement", "job1", "acceptEdits"), null));
    h.runner.cancelJob({ type: "relay_cancel_job", jobId: "job1", ticketId: "t1", reason: "user" });
    expect(h.runner.getActiveSessionId("t1")).toBeNull();
    expect(h.tracker.getSessionForTicket("t1")).toBeUndefined();
  });
});

describe("JobRunner session closed without an exit event", () => {
  it("fails the job when the user closes the agent session", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("implement", "job1", "acceptEdits"), null));
    userCloses(h.last());
    await tick();
    expect(h.ofType("cli_job_failed")).toEqual([
      expect.objectContaining({ jobId: "job1", error: expect.stringContaining("before calling complete_phase") }),
    ]);
    expect(h.runner.getActiveSessionId("t1")).toBeNull();
    expect(h.tracker.get("t1")?.activeJob).toBeNull();
  });

  it("legacy implementation still reaches done when the session is closed", async () => {
    const h = harness;
    const impl = mapStartImplementation(
      { type: "relay_start_implementation", ticketId: "t1", plan: "P", systemInstructions: [], cwd: tmp },
      undefined,
      [],
      1,
    );
    await h.runner.runJob(impl.msg, impl.options);
    userCloses(h.last());
    await tick();
    expect(h.ofType("cli_implementation_done")).toHaveLength(1);
    expect(h.ofType("cli_ticket_status").at(-1)?.status).toBe("done");
  });

  it("a SessionEnd hook (status exited while the PTY lives) does not end the job", async () => {
    const h = harness;
    await h.runner.runJob(runJobMsg(job("implement", "job1", "acceptEdits"), null));
    const s = h.last();
    s.status = "running";
    s.setStatus("exited"); // e.g. /clear fires SessionEnd; the process keeps running
    s.status = "running"; // fake getSession treats "exited" as gone; the real one does not
    await tick();
    expect(h.ofType("cli_job_failed")).toEqual([]);
    expect(h.runner.getActiveSessionId("t1")).toBe(s.id);
  });

  it("a resumed session closed by the user is not retried as a fresh session", async () => {
    const h = harness;
    const prev: TicketAgentSession = { id: UUIDS[2] as string, driver: "claude", runnerId: "runner-a", resumeCount: 0 };
    await h.runner.runJob(runJobMsg(job("implement", "job1", "acceptEdits"), prev));
    h.clock.now += 1_000;
    userCloses(h.last());
    await tick();
    expect(h.sessions).toHaveLength(1);
    expect(h.ofType("cli_job_failed").map((m) => m.jobId)).toEqual(["job1"]);
  });

  it("the idle watchdog notices a session that vanished silently", async () => {
    vi.useFakeTimers();
    const h = harness;
    await h.runner.runJob(runJobMsg(job("implement", "job1", "acceptEdits"), null));
    const s = h.last();
    s.closed = true;
    s.removeAllListeners(); // no status event at all
    vi.advanceTimersByTime(1_000);
    expect(h.ofType("cli_job_failed").map((m) => m.jobId)).toEqual(["job1"]);
  });
});
