// ---------------------------------------------------------------------------
// Local integration test: fake relay WebSocket server ⇄ real RelayClient ⇄
// real JobRunner / AgentSession / ticket workspace / MCP spawn config / hook
// server bridge / Flaio MCP server. Only the PTY layer is faked — no agent CLI
// is ever started.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket, WebSocketServer } from "ws";
import type { Job } from "../../../contracts/agent-loop.js";
import type { CliToRelayMsg, RelayRunJobMsg } from "../../relay-protocol.js";

// ---- PTY spy ---------------------------------------------------------------

interface FakePty extends EventEmitter {
  options: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> } | null;
  killed: boolean;
}

const ptys = vi.hoisted(() => [] as FakePty[]);

vi.mock("../../../terminal/pty-manager.js", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class PtyManager extends Emitter {
    options: FakePty["options"] = null;
    killed = false;
    get pid(): number | null {
      return this.options ? 4242 : null;
    }
    spawn(options: NonNullable<FakePty["options"]>): void {
      this.options = options;
      ptys.push(this as unknown as FakePty);
    }
    write(): void {}
    resize(): void {}
    kill(): void {
      this.killed = true;
    }
  }
  return { PtyManager };
});

// ---- Environment (set before the app modules load) --------------------------

const saved = {
  HOME: process.env.HOME,
  RELAY_URL: process.env.RELAY_URL,
  FLAIO_HOOK_SOCKET: process.env.FLAIO_HOOK_SOCKET,
};

let home: string;
let sockDir: string;
let project: string;
let wss: WebSocketServer;
let serverSocket: WebSocket | null = null;
const received: CliToRelayMsg[] = [];

type App = {
  RelayClient: typeof import("../../relay-client.js").RelayClient;
  HookServer: typeof import("../../../hooks/hook-server.js").HookServer;
  wireTicketIntegrations: typeof import("../ticket-integration.js").wireTicketIntegrations;
  settingsStore: typeof import("../../../store/settings-store.js").settingsStore;
  resolveMcpSession: typeof import("../../../mcp/session-registry.js").resolveMcpSession;
  server: typeof import("../../../mcp/server.js");
  readWorkspace: typeof import("../../../workspace/ticket-workspace.js").readWorkspace;
};
let app: App;
let client: InstanceType<App["RelayClient"]>;
let hookServer: InstanceType<App["HookServer"]>;

const ofType = <T extends CliToRelayMsg["type"]>(type: T) =>
  received.filter((m) => m.type === type) as Extract<CliToRelayMsg, { type: T }>[];

const sendToCli = (msg: unknown) => serverSocket?.send(JSON.stringify(msg));

function job(id: string, kind: Job["kind"], permissionMode: Job["permissionMode"]): Job {
  return {
    id,
    ticketId: "t-int",
    ownerUid: "uid-1",
    orgId: null,
    kind,
    prompt: null,
    permissionMode,
    status: "claimed",
    runnerId: null,
    leaseExpiresAt: null,
    attempts: 1,
    maxAttempts: 3,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    availableAt: null,
    runOptions: null,
    result: null,
  };
}

function runJobMsg(j: Job, agentSession: RelayRunJobMsg["ticket"]["agentSession"]): RelayRunJobMsg {
  return {
    type: "relay_run_job",
    job: j,
    ticket: {
      id: "t-int",
      title: "Integration ticket",
      cwd: project,
      useWorktree: false,
      driverName: "claude",
      model: null,
      agentSession,
    },
    briefMarkdown: `# Brief for ${j.id}\n`,
    systemInstructions: ["Be brief."],
  };
}

const flag = (args: string[], f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Element i of a list (negative = from the end); throws when missing. */
function at<T>(list: T[], i: number): T {
  const v = list.at(i);
  if (v === undefined) throw new Error(`no element ${i} (length ${list.length})`);
  return v;
}

/** The i-th spawned PTY with its spawn options. */
function pty(i: number): FakePty & { options: { args: string[]; env: Record<string, string>; cwd?: string } } {
  const p = at(ptys, i);
  if (!p.options) throw new Error(`pty ${i} not spawned`);
  return p as FakePty & { options: { args: string[]; env: Record<string, string>; cwd?: string } };
}

const mcpConfigArg = (args: string[]): string => {
  const a = args.find((x) => x.startsWith("--mcp-config="));
  if (!a) throw new Error("no --mcp-config=");
  return a.slice("--mcp-config=".length);
};

/** An MCP client wired exactly like `flaio mcp` spawned by the agent from mcp.json. */
async function mcpClientFromConfig(mcpConfigPath: string) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const json = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8")) as {
    mcpServers: { flaio: { args: string[]; env: Record<string, string> } };
  };
  const { args, env } = json.mcpServers.flaio;
  const cfg = app.server.resolveMcpRuntimeConfig(
    { ticket: flag(args, "--ticket"), job: flag(args, "--job") },
    env,
    "/unused",
  );
  const server = app.server.createFlaioMcpServer({ callTool: app.server.createProcessToolCaller(cfg), version: "test" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "agent", version: "1" });
  await Promise.all([server.connect(serverT), mcp.connect(clientT)]);
  return mcp;
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "flaio-int-home-"));
  project = path.join(home, "project");
  fs.mkdirSync(project);
  // Short dir: unix socket paths are limited to ~104 bytes.
  sockDir = fs.mkdtempSync("/tmp/fint-");
  process.env.HOME = home;
  process.env.FLAIO_HOOK_SOCKET = path.join(sockDir, "hooks.sock");

  const { WebSocketServer: Wss } = await import("ws");
  wss = new Wss({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (socket) => {
    serverSocket = socket;
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as CliToRelayMsg;
      received.push(msg);
      if (msg.type === "cli_auth") socket.send(JSON.stringify({ type: "relay_auth_ok" }));
    });
  });
  const { port } = wss.address() as { port: number };
  process.env.RELAY_URL = `ws://127.0.0.1:${port}`;

  app = {
    RelayClient: (await import("../../relay-client.js")).RelayClient,
    HookServer: (await import("../../../hooks/hook-server.js")).HookServer,
    wireTicketIntegrations: (await import("../ticket-integration.js")).wireTicketIntegrations,
    settingsStore: (await import("../../../store/settings-store.js")).settingsStore,
    resolveMcpSession: (await import("../../../mcp/session-registry.js")).resolveMcpSession,
    server: await import("../../../mcp/server.js"),
    readWorkspace: (await import("../../../workspace/ticket-workspace.js")).readWorkspace,
  };
  // In-memory only (never saved): the config dir lives in the temp HOME anyway.
  app.settingsStore.setState((s) => ({
    config: { ...s.config, relay: { ...s.config.relay, enabled: true, authToken: "test-token" } },
  }));

  hookServer = new app.HookServer();
  await hookServer.start();
  client = new app.RelayClient({ runnerHeartbeatMs: 50 });
  app.wireTicketIntegrations(client);
  await client.start();
});

afterAll(async () => {
  await client?.stop();
  await hookServer?.stop();
  await new Promise<void>((r) => wss.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sockDir, { recursive: true, force: true });
});

describe("relay ⇄ CLI job flow (fake relay, real client)", () => {
  let agentSessionId = "";
  let firstToken = "";
  let firstMcpDir = "";

  it("registers the runner after auth and heartbeats", async () => {
    await vi.waitFor(() => expect(ofType("cli_runner_register")).toHaveLength(1), { timeout: 5000 });
    const { runner } = at(ofType("cli_runner_register"), 0);
    expect(runner).toMatchObject({
      orgId: null,
      kind: "local",
      hostname: os.hostname(),
      repos: [],
      maxConcurrent: 2,
    });
    expect(runner.id).toMatch(/^runner-/);
    expect(Array.isArray(runner.drivers)).toBe(true);
    expect(runner.cliVersion).toMatch(/^\d+\.\d+\.\d+/);

    await vi.waitFor(() => expect(ofType("cli_runner_heartbeat").length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(ofType("cli_runner_heartbeat")[0]).toEqual({ type: "cli_runner_heartbeat", runnerId: runner.id, activeJobs: 0 });
  });

  it("plan job: spawns claude with a preset session, plan mode, MCP config and Stop-hook settings", async () => {
    sendToCli(runJobMsg(job("job-plan", "plan", "plan"), null));
    await vi.waitFor(() => expect(ptys).toHaveLength(1), { timeout: 5000 });

    const { args, env, cwd } = pty(0).options;
    expect(cwd).toBe(project);
    agentSessionId = flag(args, "--session-id") ?? "";
    expect(agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(args).not.toContain("--resume");
    expect(flag(args, "--permission-mode")).toBe("plan");
    const mcpConfigPath = mcpConfigArg(args);
    const settingsPath = flag(args, "--settings") ?? "";
    expect(fs.existsSync(mcpConfigPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8")).hooks.Stop).toHaveLength(1);
    expect(args.at(-2)).toBe("--");

    firstToken = env.FLAIO_MCP_TOKEN ?? "";
    firstMcpDir = path.dirname(mcpConfigPath);
    expect(env).toMatchObject({
      FLAIO_TICKET_ID: "t-int",
      FLAIO_JOB_ID: "job-plan",
      FLAIO_JOB_KIND: "plan",
      FLAIO_HOOK_SOCKET: hookServer.socketPath,
      FLAIO_TICKET_WORKTREE: project,
    });
    expect(app.resolveMcpSession(firstToken)).toMatchObject({ ticketId: "t-int", jobId: "job-plan", worktreePath: project });

    await vi.waitFor(() => expect(ofType("cli_agent_session")).toHaveLength(1));
    const claimed = ofType("cli_job_claimed");
    expect(claimed).toEqual([
      expect.objectContaining({ jobId: "job-plan", ticketId: "t-int", runnerId: at(ofType("cli_runner_register"), 0).runner.id }),
    ]);
    expect(at(ofType("cli_agent_session"), 0).agentSession).toMatchObject({ id: agentSessionId, driver: "claude", resumeCount: 0 });

    // The brief was written and started the job's phase (Stop hook).
    const ws = await app.readWorkspace(project);
    expect(ws.brief).toBe("# Brief for job-plan\n");
    expect(ws.state).toMatchObject({ ticketId: "t-int", jobId: "job-plan" });

    await vi.waitFor(() =>
      expect(ofType("cli_runner_heartbeat").at(-1)).toMatchObject({ activeJobs: 1 }),
    );
  });

  it("submit_plan + complete_phase through the hook-server bridge reach the relay", async () => {
    const mcp = await mcpClientFromConfig(mcpConfigArg(pty(0).options.args));
    const plan = { steps: ["Add the endpoint", "Test it"], risks: ["auth"], files: ["src/api.ts"], markdown: "# Plan\n\n1. Add the endpoint" };

    const r1 = await mcp.callTool({ name: "submit_plan", arguments: plan });
    expect(r1.isError).toBeFalsy();
    const r2 = await mcp.callTool({ name: "complete_phase", arguments: { result: "success", summary: "Planned" } });
    expect(r2.isError).toBeFalsy();
    await mcp.close();

    await vi.waitFor(() => expect(ofType("cli_phase_complete")).toHaveLength(1));
    const events = ofType("cli_ticket_event");
    expect(events.map((e) => e.event.kind)).toEqual(["plan_submitted"]);
    expect(events[0]).toMatchObject({
      ticketId: "t-int",
      jobId: "job-plan",
      event: { actor: { type: "agent", id: agentSessionId }, payload: { ...plan, iteration: 0 } },
    });
    expect(at(ofType("cli_phase_complete"), 0)).toEqual({
      type: "cli_phase_complete",
      ticketId: "t-int",
      jobId: "job-plan",
      phase: "plan",
      result: "success",
      summary: "Planned",
      testsRun: [],
      plan,
    });
    expect((await app.readWorkspace(project)).plan).toBe("# Plan\n\n1. Add the endpoint\n");
    // Completed: the agent stays open, its MCP session stays valid until it exits.
    expect(pty(0).killed).toBe(false);
    expect(app.resolveMcpSession(firstToken)).not.toBeNull();
  });

  it("implement job resumes the SAME agent session in acceptEdits and disposes the planning MCP session", async () => {
    const agentSession = at(ofType("cli_agent_session"), 0).agentSession;
    sendToCli(runJobMsg(job("job-impl", "implement", "acceptEdits"), agentSession));
    await vi.waitFor(() => expect(ptys).toHaveLength(2), { timeout: 5000 });

    const args = pty(1).options.args;
    expect(flag(args, "--resume")).toBe(agentSessionId);
    expect(args).not.toContain("--session-id");
    expect(flag(args, "--permission-mode")).toBe("acceptEdits");
    expect(args.some((a) => a.startsWith("--mcp-config="))).toBe(true);
    expect(flag(args, "--settings")).toBeDefined();

    // The completed planning agent was superseded: killed, token revoked, temp dir gone.
    expect(pty(0).killed).toBe(true);
    expect(app.resolveMcpSession(firstToken)).toBeNull();
    expect(fs.existsSync(firstMcpDir)).toBe(false);

    await vi.waitFor(() => expect(ofType("cli_job_claimed").map((m) => m.jobId)).toEqual(["job-plan", "job-impl"]));
    await vi.waitFor(() =>
      expect(at(ofType("cli_agent_session"), -1).agentSession).toMatchObject({ id: agentSessionId, resumeCount: 1 }),
    );
  });

  it("ignores a duplicate relay_run_job for the running job (re-claims it)", async () => {
    const agentSession = at(ofType("cli_agent_session"), 0).agentSession;
    sendToCli(runJobMsg(job("job-impl", "implement", "acceptEdits"), agentSession));
    await vi.waitFor(() => expect(ofType("cli_job_claimed").map((m) => m.jobId)).toEqual(["job-plan", "job-impl", "job-impl"]));
    expect(ptys).toHaveLength(2);
    expect(pty(1).killed).toBe(false);
  });

  it("agent exit before complete_phase: job failed, MCP session disposed", async () => {
    const token = pty(1).options.env.FLAIO_MCP_TOKEN ?? "";
    expect(app.resolveMcpSession(token)).not.toBeNull();
    // Exit 0: a non-zero exit right after a resume would be retried as a fresh session.
    pty(1).emit("exit", 0);
    await vi.waitFor(() => expect(ofType("cli_job_failed")).toHaveLength(1));
    expect(at(ofType("cli_job_failed"), 0)).toMatchObject({ jobId: "job-impl", ticketId: "t-int" });
    expect(app.resolveMcpSession(token)).toBeNull();

    // A late duplicate of the finished attempt does not start anything.
    sendToCli(runJobMsg(job("job-impl", "implement", "acceptEdits"), null));
    await new Promise((r) => setTimeout(r, 150));
    expect(ptys).toHaveLength(2);
  });

  it("stops heartbeats on disconnect and re-registers after reconnecting", async () => {
    const registers = ofType("cli_runner_register").length;
    serverSocket?.terminate();
    await vi.waitFor(() => expect(ofType("cli_runner_register").length).toBe(registers + 1), { timeout: 8000 });
    const again = at(ofType("cli_runner_register"), -1);
    expect(again.runner.id).toBe(at(ofType("cli_runner_register"), 0).runner.id);
  }, 10_000);
});
