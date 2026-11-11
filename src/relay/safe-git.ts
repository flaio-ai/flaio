// ---------------------------------------------------------------------------
// Hardened git for pull request jobs and the cloud runner.
//
// A PR worktree holds untrusted content, and after the agent ran it (and
// anything the agent could write) is treated as hostile. Every git call made
// for a PR job goes through runSafeGit:
//
//   - environment: inherited GIT_* variables are dropped (GIT_DIR,
//     GIT_CONFIG_*, GIT_EXTERNAL_DIFF, GIT_ASKPASS, ...) except the user's own
//     ssh settings; GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1 so a
//     ~/.gitconfig or system config written by an agent is never read;
//     GIT_LFS_SKIP_SMUDGE=1, GIT_TERMINAL_PROMPT=0.
//   - `-c` overrides for every config key that makes git run a program
//     (core.fsmonitor, core.hooksPath, core.pager, diff.external, credential
//     helpers, ssh command, submodules, protocol.ext, ...), plus empty
//     overrides for program-executing keys found in the repository's own
//     config (filter / textconv / merge drivers, which have arbitrary names).
//   - credentials: none by default (`credential.helper=` resets the helper
//     list). Only calls flagged `auth` (fetch, ls-remote, push) get the
//     trusted helpers snapshotted from the user's global/system config before
//     any agent started, or the cloud runner's in-memory token as a one-call
//     http header. status / add / commit never see a credential.
//
// The repository's own config cannot be ignored wholesale (remotes live
// there), so PR jobs snapshot its security-relevant keys at checkout and
// refuse to push when they changed (see assertRepoConfigUnchanged).
// ---------------------------------------------------------------------------

import { execFile as execFileCb } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface GitResult {
  stdout: string;
  stderr: string;
}

const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Inherited GIT_* variables the user may legitimately rely on for ssh pushes. */
const KEEP_GIT_ENV = new Set(["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT"]);

/** Static overrides applied to every hardened git call. */
export const SAFE_GIT_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.pager=cat",
  "core.editor=true",
  "core.askPass=",
  "core.gitProxy=",
  "core.alternateRefsCommand=",
  "core.alternateRefsPrefixes=",
  "diff.external=",
  "sequence.editor=true",
  "gpg.program=false",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "push.gpgSign=false",
  "credential.helper=",
  "protocol.ext.allow=never",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "push.recurseSubmodules=no",
  "diff.submodule=short",
  "status.submoduleSummary=false",
  "filter.lfs.process=",
  "filter.lfs.smudge=",
  "filter.lfs.clean=",
  "filter.lfs.required=false",
  "core.symlinks=true",
  "advice.detachedHead=false",
];

/**
 * Repository config keys that make git run a program (or redirect where it
 * talks to). Used to (a) blank program keys with arbitrary names found in a
 * repo config and (b) detect tampering between checkout and push.
 */
const PROGRAM_KEY_RES: RegExp[] = [
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(command|textconv)$/,
  /^merge\..+\.driver$/,
  /^remote\..+\.(uploadpack|receivepack)$/,
];

const SENSITIVE_KEY_RES: RegExp[] = [
  ...PROGRAM_KEY_RES,
  /^core\./,
  /^credential\./,
  /^alias\./,
  /^include\./,
  /^includeif\./,
  /^extensions\./,
  /^remote\./,
  /^url\./,
  /^http\./,
  /^https\./,
  /^gpg\./,
  /^pager\./,
  /^sequence\./,
  /^diff\./,
  /^filter\./,
  /^merge\./,
  /^protocol\./,
  /^submodule\./,
  /^lfs\./,
  /^uploadpack\./,
];

/** Lower-cased section and name, subsection kept (git config key normalisation). */
function normaliseKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0) return key.toLowerCase();
  if (first === last) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}.${key.slice(first + 1, last)}.${key.slice(last + 1).toLowerCase()}`;
}

export function isProgramKey(key: string): boolean {
  const k = normaliseKey(key);
  return PROGRAM_KEY_RES.some((re) => re.test(k.toLowerCase()));
}

export function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key).toLowerCase();
  return SENSITIVE_KEY_RES.some((re) => re.test(k));
}

/** Parse `git config --list -z` output ("key\nvalue\0" records). */
export function parseConfigList(stdout: string): [string, string][] {
  const out: [string, string][] = [];
  for (const rec of stdout.split("\0")) {
    if (!rec) continue;
    const nl = rec.indexOf("\n");
    out.push(nl < 0 ? [rec, ""] : [rec.slice(0, nl), rec.slice(nl + 1)]);
  }
  return out;
}

/** Process env for hardened git: inherited GIT_* dropped, global/system config off. */
export function safeGitEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.toUpperCase().startsWith("GIT_") && !KEEP_GIT_ENV.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...extra,
  };
}

// ---- trusted credentials ---------------------------------------------------

/**
 * User-level git settings a PR job may use, captured from the global and
 * system config BEFORE any agent runs: credential helpers (only for fetch /
 * push), identity and transport settings. Nothing that runs a program on
 * status/add/commit is kept.
 */
export interface TrustedGitConfig {
  /** `key=value` pairs applied to every call (identity, url rewrites, http). */
  common: string[];
  /** `key=value` credential settings applied to `auth` calls only. */
  credentials: string[];
}

export const EMPTY_TRUSTED_CONFIG: TrustedGitConfig = Object.freeze({ common: [], credentials: [] }) as TrustedGitConfig;

const TRUSTED_COMMON_RES = [/^user\.(name|email)$/, /^core\.sshcommand$/, /^url\..+\.(insteadof|pushinsteadof)$/, /^https?\./];
const TRUSTED_CREDENTIAL_RE = /^credential\./;

function filterTrusted(entries: [string, string][]): TrustedGitConfig {
  const common: string[] = [];
  const credentials: string[] = [];
  for (const [key, value] of entries) {
    const k = normaliseKey(key);
    const lower = k.toLowerCase();
    if (value.includes("\n")) continue;
    if (TRUSTED_CREDENTIAL_RE.test(lower)) credentials.push(`${k}=${value}`);
    else if (TRUSTED_COMMON_RES.some((re) => re.test(lower))) common.push(`${k}=${value}`);
  }
  return { common, credentials };
}

let trustedCache: Promise<TrustedGitConfig> | null = null;

/**
 * Snapshot of the user's global + system git settings (see TrustedGitConfig).
 * Taken once per process, at the first PR checkout, before any PR agent ran
 * (later reads could see a config an agent wrote).
 */
export function trustedGitConfig(): Promise<TrustedGitConfig> {
  trustedCache ??= (async () => {
    // The user's own environment decides which global/system files exist.
    const env = safeGitEnv(process.env);
    delete env.GIT_CONFIG_GLOBAL;
    delete env.GIT_CONFIG_NOSYSTEM;
    if (process.env.GIT_CONFIG_GLOBAL !== undefined) env.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
    if (process.env.GIT_CONFIG_NOSYSTEM !== undefined) env.GIT_CONFIG_NOSYSTEM = process.env.GIT_CONFIG_NOSYSTEM;
    const read = async (scope: "--system" | "--global") =>
      execFile("git", ["config", scope, "--no-includes", "--list", "-z"], { cwd: os.homedir(), env, timeout: 10_000 })
        .then((r) => parseConfigList(String(r.stdout)))
        .catch(() => [] as [string, string][]);
    return filterTrusted([...(await read("--system")), ...(await read("--global"))]);
  })();
  return trustedCache;
}

/** Tests: forget the snapshot. */
export function resetTrustedGitConfigForTests(value?: TrustedGitConfig): void {
  trustedCache = value ? Promise.resolve(value) : null;
}

// ---- runner token (cloud) --------------------------------------------------

/**
 * GitHub token of a cloud runner job, in this process's memory only (never
 * process.env, a file or a git config). Handed to one git process at a time
 * as an http header, and only for `auth` calls.
 */
let runnerToken: string | null = null;

export function setRunnerGitToken(token: string | null): void {
  runnerToken = token;
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

// ---- running git -------------------------------------------------------------

export interface SafeGitOptions {
  timeoutMs?: number;
  /** fetch / ls-remote / push: trusted credential helpers or the runner token. */
  auth?: boolean;
  /** Explicit git dir + work tree (a PR worktree's `.git` file is never trusted). */
  gitDir?: string;
  workTree?: string;
  /** Extra `key=value` overrides (e.g. blanks for program keys found in the repo config). */
  config?: readonly string[];
  /** Extra env (e.g. GIT_INDEX_FILE). */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Settings from trustedGitConfig(); default: none. */
  trusted?: TrustedGitConfig;
}

/** argv prefix of `-c` overrides for one call. */
export function safeConfigArgs(opts: Pick<SafeGitOptions, "auth" | "config" | "trusted"> = {}): string[] {
  const trusted = opts.trusted ?? EMPTY_TRUSTED_CONFIG;
  const pairs = [...SAFE_GIT_CONFIG, ...trusted.common, ...(opts.config ?? [])];
  // credential.helper= (in SAFE_GIT_CONFIG) resets every helper read so far;
  // trusted helpers come after it, on auth calls only.
  if (opts.auth && !runnerToken) pairs.push(...trusted.credentials);
  const args: string[] = [];
  for (const p of pairs) args.push("-c", p);
  return args;
}

/** Run git hardened (see the file header). argv only; nothing goes through a shell. */
export async function runSafeGit(cwd: string, args: string[], opts: SafeGitOptions = {}): Promise<GitResult> {
  const extraEnv: Record<string, string> = { ...(opts.env ?? {}) };
  if (opts.gitDir) extraEnv.GIT_DIR = opts.gitDir;
  if (opts.workTree) extraEnv.GIT_WORK_TREE = opts.workTree;
  if (opts.auth && runnerToken) Object.assign(extraEnv, authHeaderEnv(runnerToken));
  const { stdout, stderr } = await execFile("git", [...safeConfigArgs(opts), ...args], {
    cwd,
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: GIT_MAX_BUFFER,
    env: safeGitEnv(process.env, extraEnv),
    signal: opts.signal,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

// ---- repository config snapshot ----------------------------------------------

export interface RepoConfigSnapshot {
  /** Sensitive `key=value` entries of the repo (and worktree) config, sorted. */
  sensitive: string[];
  /** `key=` blanks for program keys with arbitrary names found there. */
  blanks: string[];
}

/** Read the security-relevant part of a repository's own config. */
export async function snapshotRepoConfig(cwd: string, opts: Pick<SafeGitOptions, "gitDir" | "workTree"> = {}): Promise<RepoConfigSnapshot> {
  const entries: [string, string][] = [];
  for (const scope of ["--local", "--worktree"]) {
    const out = await runSafeGit(cwd, ["config", scope, "--no-includes", "--list", "-z"], opts).catch(() => null);
    if (out) entries.push(...parseConfigList(out.stdout));
  }
  const sensitive = entries
    .filter(([k]) => isSensitiveKey(k))
    .map(([k, v]) => `${normaliseKey(k)}=${v}`)
    .sort();
  // Program keys with arbitrary names are blanked; a remote's upload/receive
  // pack program is reset to git's own (a blank value would break the remote).
  const blanks = [
    ...new Set(
      entries
        .filter(([k]) => isProgramKey(k))
        .map(([k]) => {
          const nk = normaliseKey(k);
          if (/\.uploadpack$/i.test(nk)) return `${nk}=git-upload-pack`;
          if (/\.receivepack$/i.test(nk)) return `${nk}=git-receive-pack`;
          return `${nk}=`;
        }),
    ),
  ];
  return { sensitive: [...new Set(sensitive)], blanks };
}

/** Keys whose sensitive entries differ between two snapshots. */
export function changedSensitiveKeys(before: RepoConfigSnapshot, after: RepoConfigSnapshot): string[] {
  const a = new Set(before.sensitive);
  const b = new Set(after.sensitive);
  const keys = new Set<string>();
  for (const e of b) if (!a.has(e)) keys.add(e.slice(0, e.indexOf("=")));
  for (const e of a) if (!b.has(e)) keys.add(e.slice(0, e.indexOf("=")));
  return [...keys].sort();
}
