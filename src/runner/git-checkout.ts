// ---------------------------------------------------------------------------
// Shallow clone of the job's repository for the cloud runner.
//
// The GitHub token never appears in argv, the remote URL, a file, a git
// config, process.env or shell history:
//   - clone: an `http.extraHeader` passed through GIT_CONFIG_* env vars of
//     that one git process (hardened like every PR-job git call);
//   - later fetches of the PR head / base: the token stays in runner memory
//     (setRunnerGitToken in ../relay/safe-git.ts) and is handed, the same way,
//     to each fetch only. No credential helper is installed, and status /
//     add / commit never see it. Cloud runners are review-only: nothing pushes.
// ---------------------------------------------------------------------------

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { authHeaderEnv, safeConfigArgs, safeGitEnv } from "../relay/safe-git.js";

export { authHeaderEnv } from "../relay/safe-git.js";

const execFileP = promisify(execFileCb);

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

/** Clone and return the checkout path. Throws with a message that never contains the token. */
export async function shallowClone(opts: CloneOptions): Promise<string> {
  if (!REPO_RE.test(opts.repository) || opts.repository.includes("..")) {
    throw new Error(`Invalid repository "${opts.repository}"`);
  }
  const git = opts.git ?? defaultGitExec;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const target = path.join(opts.dir, opts.repository.split("/")[1]);
  await fs.mkdir(opts.dir, { recursive: true, mode: 0o700 });

  // Hardened: no global/system config, hooks, filters, LFS smudge or submodules.
  const env = safeGitEnv(opts.baseEnv ?? process.env, opts.token ? authHeaderEnv(opts.token) : {});
  // The raw error may echo git's env, so only a redacted message leaves here.
  const failure = await git(
    [
      ...safeConfigArgs(),
      "clone",
      "--depth",
      String(opts.depth ?? 50),
      "--no-tags",
      "--single-branch",
      "--no-recurse-submodules",
      cloneUrl(opts.repository),
      target,
    ],
    { env, timeoutMs },
  ).then(
    () => null,
    (err: unknown) => redact(errMessage(err), opts.token),
  );
  if (failure !== null) throw new Error(`git clone of ${opts.repository} failed: ${failure}`);

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
