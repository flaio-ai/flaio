// ---------------------------------------------------------------------------
// Real wiring for `flaio runner --once` (no Ink, no TTY assumptions).
// ---------------------------------------------------------------------------

import os from "node:os";
import path from "node:path";
import { AgentSession } from "../agents/agent-session.js";
import { OpenCodeDriver } from "../agents/drivers/opencode-driver.js";
import { HookServer } from "../hooks/hook-server.js";
import { JobRunner, type JobAgentSession } from "../relay/jobs/job-runner.js";
import type { PrJobOptions } from "../relay/jobs/pr-job-runner.js";
import { flaioMcpSpawnConfigProvider, flaioTicketWorkspace } from "../relay/jobs/ticket-integration.js";
import { TicketTracker } from "../relay/ticket-tracker.js";
import { createWorktree } from "../relay/worktree-manager.js";
import { getCliVersion } from "../relay/runner-info.js";
import { providerSessionEnv } from "./agent-env.js";
import { CLOUD_DRIVER, CloudRunner, type JobRunnerContext, type RunnerJobRunner } from "./cloud-runner.js";
import { shallowClone } from "./git-checkout.js";
import { setRunnerGitToken } from "../relay/safe-git.js";
import { connectRelay } from "./relay-link.js";
import { readRunnerConfig, RUNNER_EXIT, type RunnerExitCode } from "./runner-config.js";
import { UsageCollector } from "./usage.js";

function log(line: string): void {
  process.stderr.write(`[flaio runner] ${line}\n`);
}

/** Resolve a relay cwd for the cloud job: "" means the clone; anything else must stay inside it. */
export function resolveCloudCwd(cwd: string, checkoutPath: string): string {
  if (!cwd) return checkoutPath;
  const resolved = path.resolve(checkoutPath, cwd);
  if (resolved !== checkoutPath && !resolved.startsWith(checkoutPath + path.sep)) {
    throw new Error(`Path ${cwd} is outside the cloud runner checkout`);
  }
  return resolved;
}

/** Real JobRunner for a cloud job (exported for the end-to-end test; `opts` only overrides test seams). */
export function createCloudJobRunner(
  ctx: JobRunnerContext,
  tracker: TicketTracker,
  usage: UsageCollector,
  opts: { prJobs?: Omit<PrJobOptions, "reviewOnly">; driverTmpDir?: string } = {},
): RunnerJobRunner {
  const driver = new OpenCodeDriver({ headless: true, provider: ctx.secrets.provider, tmpDir: opts.driverTmpDir });
  const sessions = new Map<string, AgentSession>();
  const runner = new JobRunner({
    send: ctx.send,
    resolveCwd: (cwd) => resolveCloudCwd(cwd, ctx.checkoutPath),
    resolveWorktree: async (resolvedCwd, ticketId, useWorktree) => {
      if (!useWorktree) return { effectiveCwd: resolvedCwd, worktreePath: null, branchName: null };
      const wt = await createWorktree(resolvedCwd, ticketId);
      return wt
        ? { effectiveCwd: wt.worktreePath, worktreePath: wt.worktreePath, branchName: wt.branchName }
        : { effectiveCwd: resolvedCwd, worktreePath: null, branchName: null };
    },
    getDriver: (name) => (name === CLOUD_DRIVER ? driver : undefined),
    createSession: (driverName, cwd) => {
      if (driverName !== CLOUD_DRIVER) return null;
      const session = new AgentSession(driver, { cwd, scrollback: 200 });
      const providerEnv = providerSessionEnv(ctx.secrets);
      const start = session.startTicket.bind(session);
      session.startTicket = (options, extraEnv) => start(options, { ...extraEnv, ...providerEnv });
      session.onRawData((data) => usage.push(data));
      sessions.set(session.id, session);
      return session as unknown as JobAgentSession;
    },
    getSession: (id) => (sessions.get(id) as unknown as JobAgentSession) ?? null,
    closeSession: (id) => {
      sessions.get(id)?.kill();
      sessions.delete(id);
    },
    // No terminal streaming from cloud runners yet.
    announceSession: () => {},
    tracker,
    workspace: flaioTicketWorkspace,
    getMcpSpawnConfig: flaioMcpSpawnConfigProvider,
    // Review-only: PrJobRunner refuses pr_fix even if CloudRunner let one through.
    prJobs: { ...opts.prJobs, reviewOnly: true },
  });
  return {
    runJob: (msg) => runner.runJob(msg),
    cancelJob: (msg) => runner.cancelJob(msg),
    activeJobIds: () => runner.activeJobIds(),
    activeJobCount: () => runner.activeJobCount(),
    dispose: () => {
      runner.dispose();
      for (const s of sessions.values()) s.kill();
      sessions.clear();
      usage.flush();
    },
  };
}

/** `flaio runner --once`. Resolves with the exit code; the caller exits the process. */
export async function runCloudRunnerOnce(): Promise<RunnerExitCode> {
  let config;
  try {
    config = readRunnerConfig();
  } catch (err) {
    log(`configuration error: ${err instanceof Error ? err.message : String(err)}`);
    return RUNNER_EXIT.CONFIG;
  }

  // Ticket state in memory only; the container is discarded after the job.
  const tracker = new TicketTracker({ filePath: null });
  const usage = new UsageCollector();
  const hookServer = new HookServer();
  try {
    await hookServer.start();
  } catch (err) {
    log(`hook server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return RUNNER_EXIT.CONFIG;
  }

  const runner = new CloudRunner({
    config,
    connect: connectRelay,
    clone: (opts) => shallowClone(opts),
    createJobRunner: (ctx) => createCloudJobRunner(ctx, tracker, usage),
    registerCheckout: (ticketId, checkoutPath) => {
      tracker.upsert(ticketId, { originalCwd: checkoutPath, driverName: CLOUD_DRIVER, useWorktree: true });
    },
    // In memory only; handed to each PR fetch as a one-call header (never process.env).
    setGitToken: (token) => setRunnerGitToken(token),
    usage: () => {
      usage.flush();
      return usage.total();
    },
    drivers: [CLOUD_DRIVER],
    cliVersion: getCliVersion(),
    hostname: `cloud-${os.hostname()}`,
    log,
  });

  const code = await runner.run();
  await hookServer.stop().catch(() => {});
  return code;
}
