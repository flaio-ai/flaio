// ---------------------------------------------------------------------------
// Cloud runner configuration from the container environment.
//
// The launcher sets exactly three variables: FLAIO_RUNNER_TOKEN (one-time,
// job-bound), FLAIO_RELAY_URL and FLAIO_JOB_ID. Provider and GitHub
// credentials are never in the environment; they come over the socket.
// ---------------------------------------------------------------------------

import os from "node:os";
import path from "node:path";

export const RUNNER_ENV = {
  token: "FLAIO_RUNNER_TOKEN",
  relayUrl: "FLAIO_RELAY_URL",
  jobId: "FLAIO_JOB_ID",
  workDir: "FLAIO_RUNNER_WORKDIR",
  timeoutMs: "FLAIO_RUNNER_TIMEOUT_MS",
} as const;

/** Exit codes of `flaio runner --once`. */
export const RUNNER_EXIT = {
  OK: 0,
  JOB_FAILED: 1,
  CONFIG: 2,
  AUTH: 3,
  SECRETS: 4,
  CHECKOUT: 5,
  DISCONNECTED: 6,
  TIMEOUT: 7,
  NO_JOB: 8,
  CANCELLED: 9,
} as const;
export type RunnerExitCode = (typeof RUNNER_EXIT)[keyof typeof RUNNER_EXIT];

export interface RunnerConfig {
  token: string;
  relayUrl: string;
  jobId: string;
  workDir: string;
  /** Hard limit for the whole run (connect → exit). */
  timeoutMs: number;
  connectTimeoutMs: number;
  secretsTimeoutMs: number;
  /** How long to wait for relay_run_job after registering. */
  claimTimeoutMs: number;
  heartbeatMs: number;
}

export const DEFAULT_RUNNER_TIMEOUT_MS = 55 * 60_000;

/**
 * Read and validate the env, then delete the token from process.env so no
 * child process (git, agent, MCP server) can inherit it.
 */
export function readRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const token = env[RUNNER_ENV.token]?.trim() ?? "";
  const relayUrl = env[RUNNER_ENV.relayUrl]?.trim() ?? "";
  const jobId = env[RUNNER_ENV.jobId]?.trim() ?? "";
  const missing = [
    !token && RUNNER_ENV.token,
    !relayUrl && RUNNER_ENV.relayUrl,
    !jobId && RUNNER_ENV.jobId,
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}`);
  if (!/^wss?:\/\//.test(relayUrl)) throw new Error(`${RUNNER_ENV.relayUrl} must be a ws:// or wss:// URL`);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new Error(`${RUNNER_ENV.jobId} is not a valid job id`);
  const timeoutRaw = Number(env[RUNNER_ENV.timeoutMs]);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_RUNNER_TIMEOUT_MS;

  delete env[RUNNER_ENV.token];

  return {
    token,
    relayUrl,
    jobId,
    workDir: env[RUNNER_ENV.workDir]?.trim() || path.join(os.tmpdir(), "flaio-runner"),
    timeoutMs,
    connectTimeoutMs: 30_000,
    secretsTimeoutMs: 30_000,
    claimTimeoutMs: 5 * 60_000,
    heartbeatMs: 30_000,
  };
}
