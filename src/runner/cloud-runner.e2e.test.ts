// ---------------------------------------------------------------------------
// End-to-end: `flaio runner --once` flow WITHOUT mocking the job runner.
//
// Fake relay (in memory) → real CloudRunner → real createCloudJobRunner
// (JobRunner + PrJobRunner + OpenCodeDriver + AgentSession/PTY + HookServer +
// Flaio MCP session) → real git against a temp "GitHub" bare repo (shallow
// clone, PR fetch, deepen, worktree, symlink neutralisation) → a fake
// `opencode` binary on PATH standing in for OpenCode.
//
// The fake agent enforces the permission rules it is handed exactly the way
// OpenCode 2.2.7 does (last matching rule wins; verified separately against
// the real binary, see opencode-driver.ts), tries to run a command and to
// edit a file, reports what it saw, and submits the review over the hook
// socket the way `flaio mcp` does. So the test proves the posture the runner
// passes (agent, rules, env, argv) denies command execution and edits.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Job, JobSecrets } from "../contracts/agent-loop.js";
import { HookServer } from "../hooks/hook-server.js";
import { setRunnerGitToken, resetTrustedGitConfigForTests, EMPTY_TRUSTED_CONFIG } from "../relay/safe-git.js";
import type { CliToRelayMsg, RelayRunJobMsg } from "../relay/relay-protocol.js";
import { TicketTracker } from "../relay/ticket-tracker.js";
import { CLOUD_DRIVER, CloudRunner } from "./cloud-runner.js";
import { createCloudJobRunner } from "./command.js";
import type { RelayLink } from "./relay-link.js";
import { RUNNER_EXIT } from "./runner-config.js";
import { UsageCollector } from "./usage.js";

const JOB_ID = "job_e2e";
const REVIEW_ID = "review_e2e";

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The fake OpenCode: argv/env/config in, simulated tool calls out, review over the hook socket. */
const FAKE_OPENCODE = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const report = { argv: process.argv.slice(2), cwd: process.cwd(), env: {}, actions: {} };
for (const k of ["OPENROUTER_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN_FLAIO_RUNNER", "FLAIO_RUNNER_TOKEN", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_CONFIG_PROJECT_DISABLE", "OPENCODE_CONFIG_CONTENT", "FLAIO_MCP_TOKEN"]) {
  report.env[k] = process.env[k] === undefined ? null : process.env[k];
}
const cfgPath = path.join(process.env.XDG_CONFIG_HOME || "/nonexistent", "opencode", "opencode.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
report.configOutsideWorktree = !path.resolve(cfgPath).startsWith(process.cwd());
report.mcpServers = Object.keys((cfg.mcp && cfg.mcp.servers) || {});
// OpenCode semantics: rules evaluated in order, the last match wins; no match = allowed by the agent defaults (plan agent: allow).
function permitted(action) {
  let effect = "allow";
  for (const r of cfg.permissions || []) if (r.action === "*" || r.action === action) effect = r.effect;
  return effect === "allow";
}
const markers = process.env.FAKE_OC_MARKERS;
// 1. Try to run a command.
report.actions.shell = permitted("shell");
if (report.actions.shell) fs.writeFileSync(path.join(markers, "shell-ran"), "x");
// 2. Try to edit a tracked file.
report.actions.edit = permitted("edit");
if (report.actions.edit) fs.writeFileSync(path.join(process.cwd(), "app.ts"), "pwned\n");
// 3. Read the diff and the brief (allowed).
report.actions.read = permitted("read");
report.diffHasChange = fs.readFileSync(path.join(process.cwd(), ".flaio", "ticket", "pr.diff"), "utf-8").includes("+export const a = 2;");
report.briefPresent = fs.existsSync(path.join(process.cwd(), ".flaio", "ticket", "brief.md"));
report.escapingLinkIsPlaceholder = !fs.lstatSync(path.join(process.cwd(), "secret-link")).isSymbolicLink();
report.submitAllowed = permitted("flaio_submit_review");
fs.writeFileSync(process.env.FAKE_OC_REPORT, JSON.stringify(report, null, 2));
// 4. submit_review the way the flaio MCP server forwards it.
const server = cfg.mcp.servers.flaio.environment;
const conn = net.createConnection(server.FLAIO_HOOK_SOCKET);
conn.on("connect", () => {
  conn.write(JSON.stringify({ type: "mcp_tool_call", payload: { token: server.FLAIO_MCP_TOKEN, tool: "submit_review", input: { verdict: "comment", summary: "Looks fine", findings: [], checkedClean: ["diff read"] }, cwd: process.cwd() } }) + "\n");
});
let buf = "";
conn.on("data", (d) => { buf += d; if (buf.includes("\n")) { fs.writeFileSync(process.env.FAKE_OC_REPORT + ".mcp", buf); conn.end(); process.exit(0); } });
conn.on("error", (e) => { fs.writeFileSync(process.env.FAKE_OC_REPORT + ".mcp", "error " + e.message); process.exit(1); });
`;

class FakeRelay {
  sent: CliToRelayMsg[] = [];
  private messageListeners: ((m: unknown) => void)[] = [];
  private closeListeners: ((r: string) => void)[] = [];
  open = true;
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
      close: () => {
        if (!relay.open) return;
        relay.open = false;
        for (const l of relay.closeListeners) l("client close");
      },
      get open() {
        return relay.open;
      },
    };
  }
  push(msg: unknown): void {
    for (const l of this.messageListeners) l(msg);
  }
  ofType<T extends CliToRelayMsg["type"]>(type: T): Extract<CliToRelayMsg, { type: T }>[] {
    return this.sent.filter((m) => m.type === type) as Extract<CliToRelayMsg, { type: T }>[];
  }
}

let tmp: string;
let bare: string;
let headSha: string;
let hookServer: HookServer;
const saved = { ...process.env };

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";
  resetTrustedGitConfigForTests(EMPTY_TRUSTED_CONFIG);
});
afterAll(() => {
  process.env = saved;
});

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flaio-cloud-e2e-")));
  // "GitHub": acme/web with main (moving on after the PR branched) and PR #3.
  bare = path.join(tmp, "remotes", "acme", "web.git");
  fs.mkdirSync(bare, { recursive: true });
  g(bare, "init", "-q", "--bare", "-b", "main");
  const seed = path.join(tmp, "seed");
  g(tmp, "clone", "-q", bare, seed);
  fs.writeFileSync(path.join(seed, "app.ts"), "export const a = 1;\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "init");
  g(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
  g(seed, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(seed, "app.ts"), "export const a = 2;\n");
  fs.symlinkSync("/etc/hosts", path.join(seed, "secret-link"));
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "change a");
  headSha = g(seed, "rev-parse", "HEAD");
  g(seed, "push", "-q", "origin", "feature");
  g(bare, "update-ref", "refs/pull/3/head", headSha);
  g(seed, "checkout", "-q", "main");
  for (let i = 0; i < 60; i++) {
    fs.writeFileSync(path.join(seed, "log.txt"), `${i}\n`);
    g(seed, "add", "log.txt");
    g(seed, "commit", "-q", "-m", `main ${i}`);
  }
  g(seed, "push", "-q", "origin", "main");

  // The fake OpenCode on PATH.
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "opencode"), `#!${process.execPath}\n${FAKE_OPENCODE}`, { mode: 0o755 });
  process.env.PATH = `${bin}:${saved.PATH}`;
  fs.mkdirSync(path.join(tmp, "markers"));
  process.env.FAKE_OC_MARKERS = path.join(tmp, "markers");
  process.env.FAKE_OC_REPORT = path.join(tmp, "report.json");

  // Private hook socket (never the developer's running Flaio).
  process.env.FLAIO_HOOK_SOCKET = path.join(tmp, "hook.sock");
  hookServer = new HookServer({ socketPath: process.env.FLAIO_HOOK_SOCKET });
  await hookServer.start();
});

afterEach(async () => {
  await hookServer.stop().catch(() => {});
  setRunnerGitToken(null);
  process.env.PATH = saved.PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function secrets(over: Partial<NonNullable<JobSecrets["github"]>> = {}): JobSecrets {
  return {
    provider: "openrouter",
    providerApiKey: "sk-or-e2e",
    model: "anthropic/claude-x",
    github: { token: "ghs_e2e_token", repository: "acme/web", access: "read", expiresAt: Date.now() + 120_000, ...over },
    expiresAt: Date.now() + 120_000,
  };
}

function runJobMsg(kind: "pr_review" | "pr_fix"): RelayRunJobMsg {
  const job: Job = {
    id: JOB_ID,
    ticketId: REVIEW_ID,
    reviewId: REVIEW_ID,
    ownerUid: "u1",
    orgId: null,
    kind,
    prompt: null,
    permissionMode: kind === "pr_review" ? "plan" : "acceptEdits",
    status: "claimed",
    runnerId: `cloud-${JOB_ID}`,
    leaseExpiresAt: null,
    attempts: 1,
    maxAttempts: 1,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    subject: { type: "pr", owner: "acme", repo: "web", number: 3, headSha, headRef: "feature", baseRef: "main", isFork: false },
    ...(kind === "pr_fix" ? { fix: { findingIds: ["f1"], target: "same_branch" as const } } : {}),
  };
  return {
    type: "relay_run_job",
    job,
    ticket: { id: REVIEW_ID, title: "Change a", cwd: "", useWorktree: true, driverName: "claude", model: null, agentSession: null },
    briefMarkdown: "# Review PR #3\n",
    systemInstructions: [],
  };
}

function cloudRunner(relay: FakeRelay, kind: "pr_review" | "pr_fix", sec: JobSecrets = secrets()) {
  relay.onSend = (msg, r) => {
    if (msg.type === "cli_auth") r.push({ type: "relay_auth_ok" });
    if (msg.type === "cli_request_job_secrets") r.push({ type: "relay_job_secrets", requestId: msg.requestId, jobId: msg.jobId, ok: true, secrets: sec });
    if (msg.type === "cli_runner_register") r.push(runJobMsg(kind));
  };
  const tracker = new TicketTracker({ filePath: null });
  const usage = new UsageCollector();
  const cloned: string[] = [];
  const runner = new CloudRunner({
    config: {
      token: "frt_e2e",
      relayUrl: "ws://relay",
      jobId: JOB_ID,
      workDir: path.join(tmp, "work"),
      timeoutMs: 60_000,
      connectTimeoutMs: 5000,
      secretsTimeoutMs: 5000,
      claimTimeoutMs: 5000,
      heartbeatMs: 60_000,
    },
    connect: async () => relay.link(),
    // shallowClone's flags (depth 50, single branch), against the local "GitHub".
    clone: async ({ repository, dir }) => {
      const target = path.join(dir, repository.split("/")[1] as string);
      fs.mkdirSync(dir, { recursive: true });
      g(dir, "clone", "-q", "--depth", "5", "--no-tags", "--single-branch", `file://${bare}`, target);
      cloned.push(target);
      return target;
    },
    createJobRunner: (ctx) => createCloudJobRunner(ctx, tracker, usage, { driverTmpDir: tmp }),
    registerCheckout: (ticketId, checkoutPath) => {
      tracker.upsert(ticketId, { originalCwd: checkoutPath, driverName: CLOUD_DRIVER, useWorktree: true });
    },
    setGitToken: (t) => setRunnerGitToken(t),
    usage: () => usage.total(),
    drivers: [CLOUD_DRIVER],
    cliVersion: "test",
    hostname: "cloud-test",
    log: () => {},
  });
  return { runner, cloned };
}

describe("cloud runner end to end (real JobRunner / PrJobRunner / git, fake OpenCode)", () => {
  it("pr_review runs read-only: no command, no edit, review submitted, worktree removed", async () => {
    const relay = new FakeRelay();
    const { runner, cloned } = cloudRunner(relay, "pr_review");
    const code = await runner.run();

    const failed = relay.ofType("cli_job_failed");
    expect(failed).toEqual([]);
    expect(code).toBe(RUNNER_EXIT.OK);
    const done = relay.ofType("cli_phase_complete");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ jobId: JOB_ID, ticketId: REVIEW_ID, phase: "pr_review", result: "success" });
    expect(done[0]?.review?.summary).toBe("Looks fine");

    const report = JSON.parse(fs.readFileSync(process.env.FAKE_OC_REPORT as string, "utf-8"));
    // The posture handed to OpenCode.
    expect(report.argv.slice(0, 2)).toEqual(["run", "--standalone"]);
    expect(report.argv[report.argv.indexOf("--agent") + 1]).toBe("plan");
    expect(report.argv).toContain("--auto");
    expect(report.argv.at(-2)).toBe("--");
    expect(report.actions).toEqual({ shell: false, edit: false, read: true });
    expect(report.submitAllowed).toBe(true);
    expect(report.mcpServers).toEqual(["flaio"]);
    expect(report.configOutsideWorktree).toBe(true);
    expect(report.env).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-e2e", // injected for this session only
      GITHUB_TOKEN: null,
      GH_TOKEN: null,
      GITHUB_TOKEN_FLAIO_RUNNER: null,
      FLAIO_RUNNER_TOKEN: null,
      FLAIO_MCP_TOKEN: null, // tokenInAgentEnv: false
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_CONFIG_PROJECT_DISABLE: "true",
      OPENCODE_CONFIG_CONTENT: "",
    });
    // The checkout the agent saw: real PR diff (after deepening the shallow clone), escaping symlink neutralised.
    expect(report.diffHasChange).toBe(true);
    expect(report.briefPresent).toBe(true);
    expect(report.escapingLinkIsPlaceholder).toBe(true);
    expect(fs.readdirSync(process.env.FAKE_OC_MARKERS as string)).toEqual([]);
    // Nothing pushed, worktree gone, token not left in the env or the clone's config.
    expect(g(bare, "rev-parse", "refs/heads/feature")).toBe(headSha);
    const clone = cloned[0] as string;
    expect(fs.readdirSync(path.join(clone, ".flaio", "worktrees")).filter((n) => n.startsWith("pr-"))).toEqual([]);
    expect(fs.readFileSync(path.join(clone, ".git", "config"), "utf-8")).not.toMatch(/credential|ghs_e2e_token/);
    expect(JSON.stringify(process.env)).not.toContain("ghs_e2e_token");
  }, 60_000);

  it("refuses a pr_fix job (review-only) before any agent runs", async () => {
    const relay = new FakeRelay();
    const { runner } = cloudRunner(relay, "pr_fix");
    const code = await runner.run();
    expect(code).toBe(RUNNER_EXIT.JOB_FAILED);
    const failed = relay.ofType("cli_job_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatch(/review-only/);
    expect(fs.existsSync(process.env.FAKE_OC_REPORT as string)).toBe(false);
    expect(g(bare, "rev-parse", "refs/heads/feature")).toBe(headSha);
  }, 60_000);

  it("refuses a GitHub token with write access without cloning", async () => {
    const relay = new FakeRelay();
    const { runner, cloned } = cloudRunner(relay, "pr_review", secrets({ access: "write" }));
    const code = await runner.run();
    expect(code).toBe(RUNNER_EXIT.SECRETS);
    expect(cloned).toEqual([]);
    expect(relay.ofType("cli_job_failed")[0]?.error).toMatch(/review-only/);
  }, 60_000);
});
