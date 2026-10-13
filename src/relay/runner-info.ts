// ---------------------------------------------------------------------------
// Runner identity for the job orchestrator: what cli_runner_register reports.
// ---------------------------------------------------------------------------

import { execFile as execFileCb } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CliRunnerRegisterMsg } from "./relay-protocol.js";

const execFile = promisify(execFileCb);

/** At most this many repos are reported (tickets.json can list many projects). */
const MAX_REPOS = 50;

/**
 * Normalize a git remote URL so ssh and https forms compare equal:
 * `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both become
 * `github.com/org/repo`. Same rules as the relay's dispatcher.
 */
export function normalizeRepoUrl(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^[a-z+]+:\/\//, "");
  u = u.replace(/^[^@/]+@/, "");
  u = u.replace(/^([^/:]+):(?!\d)/, "$1/");
  u = u.replace(/\.git$/, "").replace(/\/+$/, "");
  return u;
}

/** `origin` remote of a project dir, or null (not a repo / no origin / git missing). */
export async function getOriginUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["remote", "get-url", "origin"], { cwd, timeout: 3000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Normalized, de-duplicated origin URLs of the given project dirs. */
export async function collectRepos(
  cwds: string[],
  getOrigin: (cwd: string) => Promise<string | null> = getOriginUrl,
): Promise<string[]> {
  const unique = [...new Set(cwds.filter(Boolean))].slice(0, MAX_REPOS);
  const urls = await Promise.all(unique.map((c) => getOrigin(c).catch(() => null)));
  return [...new Set(urls.filter((u): u is string => !!u).map(normalizeRepoUrl))];
}

let cachedVersion: string | null = null;

/** flaio CLI version (package.json next to src/ or dist/). */
export function getCliVersion(): string {
  if (process.env.FLAIO_VERSION) return process.env.FLAIO_VERSION;
  if (cachedVersion) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "..", "package.json"), "utf-8")) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export interface RunnerRegistrationInput {
  runnerId: string;
  /** Installed driver names. */
  drivers: string[];
  /** Project dirs this runner has worked in (tickets.json). */
  projectCwds: string[];
  maxConcurrent: number;
  hostname?: string;
  cliVersion?: string;
  getOrigin?: (cwd: string) => Promise<string | null>;
}

export async function buildRunnerRegisterMsg(input: RunnerRegistrationInput): Promise<CliRunnerRegisterMsg> {
  return {
    type: "cli_runner_register",
    runner: {
      id: input.runnerId,
      orgId: null,
      kind: "local",
      hostname: input.hostname ?? os.hostname(),
      drivers: input.drivers,
      repos: await collectRepos(input.projectCwds, input.getOrigin),
      maxConcurrent: Math.max(1, Math.floor(input.maxConcurrent)),
      cliVersion: input.cliVersion ?? getCliVersion(),
    },
  };
}
