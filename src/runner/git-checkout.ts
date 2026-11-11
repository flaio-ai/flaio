// ---------------------------------------------------------------------------
// Shallow clone of the job's repository for the cloud runner.
//
// The GitHub token never appears in argv, the remote URL, a file or shell
// history:
//   - clone: an `http.extraHeader` passed through GIT_CONFIG_* env vars of
//     that one git process;
//   - later git calls in the runner process (PR fetch, pr_fix push): a
//     credential helper in the clone's .git/config that prints the token from
//     RUNNER_GIT_TOKEN_ENV. That env var only exists in the runner process and
//     matches the pty-manager scrub (^GITHUB_TOKEN), so the agent never gets it.
// ---------------------------------------------------------------------------

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFileCb);

export const RUNNER_GIT_TOKEN_ENV = "GITHUB_TOKEN_FLAIO_RUNNER";

/** Credential helper (shell snippet run by git). References the env var, not the token. */
export const CREDENTIAL_HELPER =
  `!f() { test "$1" = get || exit 0; test -n "$${RUNNER_GIT_TOKEN_ENV}" || exit 0; ` +
  `printf 'username=x-access-token\\npassword=%s\\n' "$${RUNNER_GIT_TOKEN_ENV}"; }; f`;

export type GitExec = (
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string }>;

export const defaultGitExec: GitExec = async (args, opts) => {
  const { stdout } = await execFileP("git", args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout };
};

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface CloneOptions {
  /** "owner/repo" */
  repository: string;
  token: string | null;
  /** Parent directory; the clone goes to `<dir>/<repo>`. */
  dir: string;
  depth?: number;
  timeoutMs?: number;
  git?: GitExec;
  /** Env the git process inherits (default process.env). */
  baseEnv?: NodeJS.ProcessEnv;
}

export function cloneUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

/** Env for one git process carrying the token as an Authorization header. */
export function authHeaderEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`, "utf-8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Clone and return the checkout path. Throws with a message that never contains the token. */
export async function shallowClone(opts: CloneOptions): Promise<string> {
  if (!REPO_RE.test(opts.repository) || opts.repository.includes("..")) {
    throw new Error(`Invalid repository "${opts.repository}"`);
  }
  const git = opts.git ?? defaultGitExec;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const target = path.join(opts.dir, opts.repository.split("/")[1]);
  await fs.mkdir(opts.dir, { recursive: true, mode: 0o700 });

  const env: NodeJS.ProcessEnv = {
    ...(opts.baseEnv ?? process.env),
    GIT_TERMINAL_PROMPT: "0",
    ...(opts.token ? authHeaderEnv(opts.token) : {}),
  };
  // The raw error may echo git's env, so only a redacted message leaves here.
  const failure = await git(
    ["clone", "--depth", String(opts.depth ?? 50), "--no-tags", "--single-branch", cloneUrl(opts.repository), target],
    { env, timeoutMs },
  ).then(
    () => null,
    (err: unknown) => redact(errMessage(err), opts.token),
  );
  if (failure !== null) throw new Error(`git clone of ${opts.repository} failed: ${failure}`);

  // Later fetch/push from the runner process: helper reads the token from its env.
  await git(["config", "--local", "credential.https://github.com.helper", CREDENTIAL_HELPER], {
    cwd: target,
    timeoutMs: 10_000,
  });
  await git(["config", "--local", "credential.https://github.com.useHttpPath", "false"], {
    cwd: target,
    timeoutMs: 10_000,
  });
  return target;
}

export function redact(text: string, token: string | null): string {
  if (!token) return text;
  const basic = Buffer.from(`x-access-token:${token}`, "utf-8").toString("base64");
  return text.split(token).join("***").split(basic).join("***");
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err && typeof (err as { stderr: unknown }).stderr === "string") {
    const stderr = (err as { stderr: string }).stderr.trim();
    if (stderr) return stderr.slice(-500);
  }
  return err instanceof Error ? err.message : String(err);
}
