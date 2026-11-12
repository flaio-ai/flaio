// ---------------------------------------------------------------------------
// Pull request checkouts for pr_review / pr_fix jobs (local and cloud runners)
//
//   resolvePrRepo   — find a tracked project dir whose git remote is the PR's
//                     owner/repo (never clones; no match fails the job)
//   checkoutPr      — fetch pull/<n>/head (+ the base branch, deepening a
//                     shallow clone until they share a merge base) into
//                     private refs/flaio/* refs, verify the head sha, add a
//                     detached worktree under .flaio/worktrees/ (user's
//                     checkout untouched), neutralise symlinks that leave it
//   writePrDiff     — .flaio/ticket/pr.diff for the agent (size-capped)
//   finishPrFix     — build ONE commit on top of the PR head from what the
//                     agent changed, check the change set, push (never force)
//   cleanupPrCheckout / sweepStalePrCheckouts — remove worktrees and refs
//
// Every git call goes through runSafeGit (./safe-git.ts): no hooks, no
// fsmonitor / pager / external diff / filter drivers / submodules / LFS,
// global and system config ignored, credentials only on fetch and push. The
// worktree holds untrusted PR content and, once the agent ran, is hostile:
// its `.git` file is never trusted (git runs with an explicit GIT_DIR), and
// the push is refused when the repository's config changed since checkout.
// Fixes on fork PRs are refused (nothing derived from a fork is pushed).
// ---------------------------------------------------------------------------

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrFixInput, PrJobSubject } from "../contracts/agent-loop.js";
import { writePrWorkspaceFile } from "../workspace/ticket-workspace.js";
import { makeDebugLog } from "../connectors/debug.js";
import { normalizeRepoUrl } from "./runner-info.js";
import {
  changedSensitiveKeys,
  runSafeGit,
  snapshotRepoConfig,
  trustedGitConfig,
  EMPTY_TRUSTED_CONFIG,
  type GitResult,
  type RepoConfigSnapshot,
  type SafeGitOptions,
  type TrustedGitConfig,
} from "./safe-git.js";
import {
  addDetachedWorktree,
  ensureFlaioExcluded,
  flaioWorktreesDir,
  listFlaioWorktreePaths,
  removeDetachedWorktree,
} from "./worktree-manager.js";

export type { GitResult } from "./safe-git.js";

const debugLog = makeDebugLog("pr-jobs");

export type PrJobErrorCode =
  | "no_checkout"
  | "invalid_subject"
  | "fetch_failed"
  | "head_moved"
  | "no_diff"
  | "fork_same_branch"
  | "fork_fix_refused"
  | "invalid_branch"
  | "branch_exists"
  | "no_changes"
  | "history_rewritten"
  | "unsafe_checkout"
  | "unsafe_changes"
  | "config_tampered"
  | "commit_failed"
  | "push_rejected"
  | "cancelled";

/** A PR job failure with a message meant for the user (sent as cli_job_failed.error). */
export class PrJobError extends Error {
  constructor(
    readonly code: PrJobErrorCode,
    message: string,
    /** "cancelled" during a push: whether the branch was found at the fix commit afterwards (null = unknown). */
    readonly pushed: boolean | null = null,
  ) {
    super(message);
    this.name = "PrJobError";
  }
}

// ---- git -------------------------------------------------------------------

/** Run git hardened (see ./safe-git.ts). A number is the timeout in ms. */
export async function git(cwd: string, args: string[], opts: number | SafeGitOptions = {}): Promise<GitResult> {
  return runSafeGit(cwd, args, typeof opts === "number" ? { timeoutMs: opts } : opts);
}

/** stderr (or message) of a failed git call, credentials scrubbed and size-capped. */
export function gitErrorMessage(err: unknown, max = 1500): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const raw = (typeof e?.stderr === "string" && e.stderr.trim()) || (typeof e?.message === "string" ? e.message : String(err));
  const scrubbed = raw
    .replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***")
    .replace(/(AUTHORIZATION:\s*basic\s+)[A-Za-z0-9+/=]+/gi, "$1***")
    .trim();
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
}

// ---- input validation --------------------------------------------------------

/**
 * Conservative check of a branch name from job input (subset of git's
 * check-ref-format rules, plus: no leading "-" or "+", printable ASCII only).
 * Branch names end up in refspecs, so this runs before any git call.
 */
export function isSafeBranchName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (/^[-+./]/.test(name) || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("/.") || name.includes("@{")) return false;
  if (name === "HEAD" || name === "@") return false;
  return true;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;

/** Throw PrJobError("invalid_subject") unless every field used in git argv is well-formed. */
export function validatePrSubject(subject: PrJobSubject): void {
  const bad = (what: string) => {
    throw new PrJobError("invalid_subject", `The pull request job has an invalid ${what}; nothing was fetched.`);
  };
  if (!Number.isSafeInteger(subject.number) || subject.number <= 0) bad("number");
  if (typeof subject.headSha !== "string" || !SHA_RE.test(subject.headSha)) bad("head commit");
  if (!isSafeBranchName(subject.baseRef)) bad("base branch name");
  if (!isSafeBranchName(subject.headRef)) bad("head branch name");
  if (typeof subject.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(subject.owner)) bad("owner");
  if (typeof subject.repo !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(subject.repo) || subject.repo.startsWith(".")) bad("repository name");
}

// ---- repo resolution -------------------------------------------------------

export interface GitRemote {
  name: string;
  url: string;
}

/** Fetch remotes of a project dir (empty when it is not a repo). */
export async function listRemotes(cwd: string): Promise<GitRemote[]> {
  try {
    const { stdout } = await runSafeGit(cwd, ["remote", "-v"], { timeoutMs: 5000 });
    const out: GitRemote[] = [];
    for (const line of stdout.split("\n")) {
      const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (m && m[1] && m[2]) out.push({ name: m[1], url: m[2] });
    }
    return out;
  } catch {
    return [];
  }
}

/** Absolute git common dir (shared by a repo and its linked worktrees), or null. */
export async function gitCommonDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runSafeGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 5000 });
    const dir = stdout.trim();
    return dir ? await fsp.realpath(dir).catch(() => dir) : null;
  } catch {
    return null;
  }
}

/** Top level of the working tree that holds `cwd`. */
async function repoTopLevel(cwd: string): Promise<string> {
  const { stdout } = await runSafeGit(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 5000 });
  return stdout.trim();
}

/**
 * Whether a remote URL points at `owner/repo`: the last two path segments of
 * the normalized URL (ssh, https, host aliases and GHE hosts all reduce to
 * `<host>/<owner>/<repo>`), compared case-insensitively.
 */
export function remoteMatchesRepo(url: string, owner: string, repo: string): boolean {
  const parts = normalizeRepoUrl(url).split("/").filter(Boolean);
  if (parts.length < 2) return false;
  const [o, r] = parts.slice(-2);
  return o === owner.toLowerCase() && r === repo.toLowerCase().replace(/\.git$/, "");
}

export interface PrRepoMatch {
  /** Main working tree of the matching repo (worktrees are created under it). */
  repoRoot: string;
  /** Remote to fetch from / push to. */
  remote: string;
  remoteUrl: string;
  /** The tracked project dir that matched. */
  cwd: string;
}

export interface ResolvePrRepoDeps {
  listRemotes?: (cwd: string) => Promise<GitRemote[]>;
  commonDir?: (cwd: string) => Promise<string | null>;
  topLevel?: (cwd: string) => Promise<string>;
}

const REMOTE_PREFERENCE = ["origin", "upstream"];

/**
 * Find the local checkout of the PR's repository among the project dirs this
 * runner tracks. Clones of the same repo (or linked worktrees of one) count
 * once; with several distinct clones the first in `candidateCwds` order wins.
 * Throws PrJobError("no_checkout") when nothing matches — the runner never
 * clones into the user's disk on its own.
 */
export async function resolvePrRepo(
  subject: Pick<PrJobSubject, "owner" | "repo">,
  candidateCwds: string[],
  deps: ResolvePrRepoDeps = {},
): Promise<{ match: PrRepoMatch; others: PrRepoMatch[] }> {
  const remotesOf = deps.listRemotes ?? listRemotes;
  const commonDirOf = deps.commonDir ?? gitCommonDir;
  const topLevelOf = deps.topLevel ?? repoTopLevel;
  const seen = new Set<string>();
  const matches: PrRepoMatch[] = [];

  for (const cwd of [...new Set(candidateCwds.filter(Boolean))]) {
    const remotes = (await remotesOf(cwd).catch(() => [])).filter((r) => remoteMatchesRepo(r.url, subject.owner, subject.repo));
    if (remotes.length === 0) continue;
    const common = (await commonDirOf(cwd).catch(() => null)) ?? cwd;
    if (seen.has(common)) continue;
    seen.add(common);
    remotes.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    const remote = remotes[0] as GitRemote;
    // Worktrees go under the main working tree (the parent of a non-bare common dir).
    let repoRoot: string;
    if (path.basename(common) === ".git") repoRoot = path.dirname(common);
    else repoRoot = await topLevelOf(cwd).catch(() => cwd);
    matches.push({ repoRoot, remote: remote.name, remoteUrl: remote.url, cwd });
  }

  const [match, ...others] = matches;
  if (!match) {
    throw new PrJobError(
      "no_checkout",
      `This runner has no checkout of ${subject.owner}/${subject.repo}. Open a Flaio session in a clone of that repository on this machine (or run the job on another runner).`,
    );
  }
  if (others.length) {
    debugLog(`pr-jobs: ${subject.owner}/${subject.repo} has ${matches.length} local clones; using ${match.repoRoot}`);
  }
  return { match, others };
}

function rank(remoteName: string): number {
  const i = REMOTE_PREFERENCE.indexOf(remoteName);
  return i < 0 ? REMOTE_PREFERENCE.length : i;
}

// ---- checkout --------------------------------------------------------------

function segment(s: string, max: number): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "x"
  );
}

/** Name prefix shared by every worktree / ref of one PR: `pr-<owner>-<repo>-<n>-`. */
export function prCheckoutPrefix(subject: Pick<PrJobSubject, "owner" | "repo" | "number">): string {
  return `pr-${segment(subject.owner, 30)}-${segment(subject.repo, 40)}-${segment(String(subject.number), 12)}-`;
}

/** Worktree / ref name of one job attempt. */
export function prCheckoutName(
  subject: Pick<PrJobSubject, "owner" | "repo" | "number">,
  jobId: string,
  attempt: number,
): string {
  return `${prCheckoutPrefix(subject)}${segment(jobId, 12)}-${segment(String(attempt), 6)}`;
}

export interface PrCheckout {
  repoRoot: string;
  remote: string;
  /** URL of `remote` (informational). */
  remoteUrl?: string;
  /** Worktree / ref name (see prCheckoutName). */
  name: string;
  worktreePath: string;
  /** Private refs: `<refBase>/head`, `<refBase>/base`. */
  refBase: string;
  headSha: string;
  /** Tip of the fetched base branch; null when it could not be fetched. */
  baseSha: string | null;
  /** Merge base of base and head (the diff's left side); null when none could be found. */
  mergeBase?: string | null;
  /** Absolute admin dir of the worktree (git runs with GIT_DIR=this, never the worktree's `.git` file). */
  gitDir?: string;
  /** Security-relevant repo config at checkout (before any agent ran). */
  repoConfig?: RepoConfigSnapshot;
  /** User-level git settings snapshotted before any agent ran. */
  trusted?: TrustedGitConfig;
  /** Repo-relative paths of symlinks that pointed outside the worktree, replaced by placeholder files. */
  neutralisedLinks?: string[];
}

/** Hardened git options for calls inside a checkout's worktree. */
function wtGit(checkout: PrCheckout, extra: Omit<SafeGitOptions, "gitDir" | "workTree" | "trusted"> = {}): SafeGitOptions {
  return {
    ...extra,
    ...(checkout.gitDir ? { gitDir: checkout.gitDir, workTree: checkout.worktreePath } : {}),
    config: [...(checkout.repoConfig?.blanks ?? []), ...(extra.config ?? [])],
    trusted: checkout.trusted ?? EMPTY_TRUSTED_CONFIG,
  };
}

/** Hardened git options for calls in the main repository. */
function repoGit(checkout: Pick<PrCheckout, "repoConfig" | "trusted">, extra: Omit<SafeGitOptions, "trusted"> = {}): SafeGitOptions {
  return {
    ...extra,
    config: [...(checkout.repoConfig?.blanks ?? []), ...(extra.config ?? [])],
    trusted: checkout.trusted ?? EMPTY_TRUSTED_CONFIG,
  };
}

function shaMatches(actual: string, expected: string): boolean {
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  return e.length >= 7 && (a === e || a.startsWith(e));
}

async function deleteRefs(repoRoot: string, refs: string[], opts: SafeGitOptions = {}): Promise<void> {
  for (const ref of refs) {
    await git(repoRoot, ["update-ref", "-d", ref], opts).catch(() => undefined);
  }
}

/**
 * Remove worktrees and private refs of a PR left behind by earlier jobs
 * (crash, killed CLI) — every name with the PR's prefix except `keepNames`.
 */
export async function sweepStalePrCheckouts(
  repoRoot: string,
  prefix: string,
  keepNames: ReadonlySet<string>,
): Promise<string[]> {
  const removed: string[] = [];
  const base = flaioWorktreesDir(repoRoot);
  const candidates = new Set<string>();
  for (const p of await listFlaioWorktreePaths(repoRoot).catch(() => [] as string[])) candidates.add(path.basename(p));
  for (const entry of await fsp.readdir(base).catch(() => [] as string[])) candidates.add(entry);
  for (const name of candidates) {
    if (!name.startsWith(prefix) || keepNames.has(name)) continue;
    await removeDetachedWorktree(repoRoot, path.join(base, name)).catch((err) =>
      debugLog(`pr-jobs: removing stale worktree ${name} failed: ${gitErrorMessage(err)}`),
    );
    removed.push(name);
  }
  const { stdout } = await git(repoRoot, ["for-each-ref", "--format=%(refname)", "refs/flaio/"]).catch(() => ({
    stdout: "",
    stderr: "",
  }));
  const staleRefs = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((ref) => {
      const name = ref.split("/")[2] ?? "";
      return ref.startsWith("refs/flaio/") && name.startsWith(prefix) && !keepNames.has(name);
    });
  await deleteRefs(repoRoot, staleRefs);
  if (removed.length) debugLog(`pr-jobs: swept ${removed.length} stale PR worktree(s) in ${repoRoot}`);
  return removed;
}

export interface CheckoutPrOptions {
  jobId: string;
  attempt: number;
  /** Names of checkouts still owned by live jobs in this process (never swept). */
  activeNames: ReadonlySet<string>;
  fetchTimeoutMs?: number;
}

/** Shallow clones (cloud runner): fetch this deep first, then deepen in these steps until head and base meet. */
export const SHALLOW_FETCH_DEPTH = 50;
export const DEEPEN_STEPS = [200, 1000, 5000] as const;
/** More symlinks than this in a PR checkout: refuse the job rather than scan them all. */
export const MAX_SYMLINKS = 5000;

async function isShallow(repoRoot: string, opts: SafeGitOptions): Promise<boolean> {
  const out = await git(repoRoot, ["rev-parse", "--is-shallow-repository"], opts).catch(() => null);
  return out?.stdout.trim() === "true";
}

async function mergeBaseOf(repoRoot: string, a: string, b: string, opts: SafeGitOptions): Promise<string | null> {
  const out = await git(repoRoot, ["merge-base", a, b], opts).catch(() => null);
  const sha = out?.stdout.trim() ?? "";
  return SHA_RE.test(sha) ? sha : null;
}

/**
 * Fetch the PR head (and base) from the matching remote into private refs,
 * verify the head is `subject.headSha`, and add a detached worktree at it.
 * Never touches the user's working tree, branches or current HEAD.
 */
export async function checkoutPr(match: PrRepoMatch, subject: PrJobSubject, opts: CheckoutPrOptions): Promise<PrCheckout> {
  validatePrSubject(subject);
  const { repoRoot, remote } = match;
  const name = prCheckoutName(subject, opts.jobId, opts.attempt);
  const refBase = `refs/flaio/${name}`;

  // Snapshots taken before any agent of this job runs (see finishPrFix).
  const trusted = await trustedGitConfig();
  const repoConfig = await snapshotRepoConfig(repoRoot);
  const ctx = { repoConfig, trusted };
  const plain = repoGit(ctx);

  await sweepStalePrCheckouts(repoRoot, prCheckoutPrefix(subject), new Set([...opts.activeNames, name]));

  const timeout = opts.fetchTimeoutMs ?? 180_000;
  const shallow = await isShallow(repoRoot, plain);
  const fetchArgs = ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", ...(shallow ? [`--depth=${SHALLOW_FETCH_DEPTH}`] : [])];
  const headSpec = `+refs/pull/${subject.number}/head:${refBase}/head`;
  const baseSpec = `+refs/heads/${subject.baseRef}:${refBase}/base`;
  try {
    await git(repoRoot, [...fetchArgs, remote, headSpec], repoGit(ctx, { auth: true, timeoutMs: timeout }));
  } catch (err) {
    await deleteRefs(repoRoot, [`${refBase}/head`], plain);
    throw new PrJobError("fetch_failed", `Fetching pull/${subject.number}/head from ${remote} failed: ${gitErrorMessage(err)}`);
  }
  const headSha = (await git(repoRoot, ["rev-parse", `${refBase}/head^{commit}`], plain)).stdout.trim();
  if (!shaMatches(headSha, subject.headSha)) {
    await deleteRefs(repoRoot, [`${refBase}/head`], plain);
    throw new PrJobError(
      "head_moved",
      `The pull request head moved: the job is for ${subject.headSha.slice(0, 12)} but ${remote} now has ${headSha.slice(0, 12)}. Start a new run on the current head.`,
    );
  }

  let baseSha: string | null = null;
  try {
    await git(repoRoot, [...fetchArgs, remote, baseSpec], repoGit(ctx, { auth: true, timeoutMs: timeout }));
    baseSha = (await git(repoRoot, ["rev-parse", `${refBase}/base^{commit}`], plain)).stdout.trim() || null;
  } catch (err) {
    debugLog(`pr-jobs: fetching base ${subject.baseRef} failed (diff unavailable): ${gitErrorMessage(err)}`);
  }

  // A shallow clone may hold too little history for a merge base: deepen, bounded.
  let mergeBase = baseSha ? await mergeBaseOf(repoRoot, baseSha, headSha, plain) : null;
  if (baseSha && !mergeBase && shallow) {
    for (const step of DEEPEN_STEPS) {
      try {
        await git(
          repoRoot,
          ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", `--deepen=${step}`, remote, headSpec, baseSpec],
          repoGit(ctx, { auth: true, timeoutMs: timeout }),
        );
      } catch (err) {
        debugLog(`pr-jobs: deepening by ${step} failed: ${gitErrorMessage(err)}`);
        break;
      }
      mergeBase = await mergeBaseOf(repoRoot, baseSha, headSha, plain);
      if (mergeBase) break;
    }
  }

  let worktreePath: string;
  try {
    // Keep .flaio/ (worktrees, workspace files) out of the user's `git status`.
    await ensureFlaioExcluded(repoRoot);
    worktreePath = await addDetachedWorktree(repoRoot, name, headSha, { config: repoConfig.blanks });
  } catch (err) {
    await deleteRefs(repoRoot, [`${refBase}/head`, `${refBase}/base`], plain);
    throw new Error(`Creating the review worktree failed: ${gitErrorMessage(err)}`, { cause: err });
  }
  const checkout: PrCheckout = {
    repoRoot,
    remote,
    remoteUrl: match.remoteUrl,
    name,
    worktreePath,
    refBase,
    headSha,
    baseSha,
    mergeBase,
    repoConfig,
    trusted,
    neutralisedLinks: [],
  };
  try {
    // Pin the admin dir now: after the agent ran, `<wt>/.git` may point anywhere.
    checkout.gitDir = (await git(worktreePath, ["rev-parse", "--absolute-git-dir"], plain)).stdout.trim();
    // A .flaio directory shipped by the PR must not shadow (or redirect) the
    // workspace Flaio writes; rm removes a symlink itself, never its target.
    await fsp.rm(path.join(worktreePath, ".flaio"), { recursive: true, force: true });
    checkout.neutralisedLinks = await neutraliseEscapingSymlinks(checkout);
  } catch (err) {
    await cleanupPrCheckout(checkout);
    if (err instanceof PrJobError) throw err;
    throw new Error(`Preparing the review worktree failed: ${gitErrorMessage(err)}`, { cause: err });
  }

  debugLog(`pr-jobs: checked out ${subject.owner}/${subject.repo}#${subject.number} at ${headSha} in ${worktreePath}`);
  return checkout;
}

/** Placeholder content for a symlink that pointed outside the worktree. */
export function symlinkPlaceholder(target: string): string {
  return `flaio: this path is a symbolic link to ${JSON.stringify(target.slice(0, 300))}, outside the repository; it was replaced for this run.\n`;
}

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

/**
 * Replace every tracked symlink (mode 120000) whose target resolves outside
 * the worktree (absolute, `..` out, or via other links) with an inert
 * placeholder file, so an agent can neither read nor write through it.
 * Returns the replaced repo-relative paths.
 */
export async function neutraliseEscapingSymlinks(checkout: PrCheckout): Promise<string[]> {
  const wt = checkout.worktreePath;
  const realWt = await fsp.realpath(wt);
  const { stdout } = await git(wt, ["ls-files", "-s", "-z"], wtGit(checkout));
  const links: string[] = [];
  for (const rec of stdout.split("\0")) {
    if (!rec.startsWith("120000 ")) continue;
    const tab = rec.indexOf("\t");
    if (tab > 0) links.push(rec.slice(tab + 1));
  }
  if (links.length > MAX_SYMLINKS) {
    throw new PrJobError("unsafe_checkout", `The pull request contains ${links.length} symbolic links (limit ${MAX_SYMLINKS}); not running an agent on it.`);
  }
  const replaced: string[] = [];
  const replace = async (rel: string, abs: string, target: string) => {
    await fsp.unlink(abs);
    await fsp.writeFile(abs, symlinkPlaceholder(target), { flag: "wx", mode: 0o644 });
    replaced.push(rel);
  };
  // Decide on the pristine tree first (so chains through other escaping links
  // are still resolvable), then replace.
  const escaping: { rel: string; abs: string; target: string }[] = [];
  for (const rel of links) {
    const abs = path.join(wt, rel);
    if (!isInside(wt, abs)) continue;
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st?.isSymbolicLink()) continue;
    const target = await fsp.readlink(abs);
    // Lexical: absolute targets and `..` escapes.
    const lexical = path.resolve(path.dirname(abs), target);
    let out = path.isAbsolute(target) || !isInside(wt, lexical);
    // Real resolution through chains of links.
    if (!out) {
      const real = await fsp.realpath(abs).catch(() => null);
      out = real !== null && !isInside(realWt, real);
    }
    if (out) escaping.push({ rel, abs, target });
  }
  for (const { rel, abs, target } of escaping) await replace(rel, abs, target);
  if (replaced.length) debugLog(`pr-jobs: neutralised ${replaced.length} symlink(s) pointing outside ${wt}`);
  return replaced;
}

/** Remove the job's worktree and private refs. Safe to call more than once. */
export async function cleanupPrCheckout(
  checkout: Pick<PrCheckout, "repoRoot" | "worktreePath" | "refBase"> & Partial<Pick<PrCheckout, "repoConfig" | "trusted">>,
): Promise<void> {
  await removeDetachedWorktree(checkout.repoRoot, checkout.worktreePath, { config: checkout.repoConfig?.blanks }).catch((err) =>
    debugLog(`pr-jobs: removing ${checkout.worktreePath} failed: ${gitErrorMessage(err)}`),
  );
  await deleteRefs(checkout.repoRoot, [`${checkout.refBase}/head`, `${checkout.refBase}/base`], repoGit(checkout));
}

// ---- diff for the agent ----------------------------------------------------

export const PR_DIFF_MAX_BYTES = 1_500_000;

/** Write `.flaio/ticket/pr.diff`: commits, stat and the diff against the merge base (capped). Null when no diff could be produced. */
export async function writePrDiff(checkout: PrCheckout, subject: PrJobSubject, maxBytes = PR_DIFF_MAX_BYTES): Promise<string | null> {
  if (!checkout.baseSha) return null;
  const base = checkout.mergeBase === undefined ? checkout.baseSha : checkout.mergeBase;
  if (!base) return null;
  const wt = checkout.worktreePath;
  const opts = wtGit(checkout);
  try {
    const log = await git(wt, ["log", "--no-color", "--oneline", "--max-count=200", `${base}..${checkout.headSha}`], opts);
    const stat = await git(wt, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", base, checkout.headSha], opts);
    const diff = await git(wt, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, checkout.headSha], opts);
    let body = diff.stdout;
    let truncated = false;
    if (Buffer.byteLength(body, "utf-8") > maxBytes) {
      body = Buffer.from(body, "utf-8").subarray(0, maxBytes).toString("utf-8");
      truncated = true;
    }
    const header = [
      `# ${subject.owner}/${subject.repo}#${subject.number}: ${subject.headRef} -> ${subject.baseRef}`,
      `# head ${checkout.headSha}  base ${subject.baseRef} @ ${checkout.baseSha}  merge base ${base}`,
      "#",
      "# Commits:",
      ...log.stdout.trimEnd().split("\n").filter(Boolean).map((l) => `#   ${l}`),
      "#",
      ...stat.stdout.trimEnd().split("\n").map((l) => `# ${l}`),
      ...(checkout.neutralisedLinks?.length
        ? ["#", `# NOTE: ${checkout.neutralisedLinks.length} symbolic link(s) pointing outside the repository were replaced by placeholder files.`]
        : []),
      ...(truncated ? ["#", `# NOTE: diff truncated at ${maxBytes} bytes; read the files directly for the rest.`] : []),
      "",
    ].join("\n");
    return await writePrWorkspaceFile(wt, "diff", `${header}\n${body}`);
  } catch (err) {
    debugLog(`pr-jobs: writing pr.diff failed: ${gitErrorMessage(err)}`);
    return null;
  }
}

// ---- fix: commit and push --------------------------------------------------

export function defaultFixBranchName(subject: Pick<PrJobSubject, "number">, jobId: string): string {
  return `flaio/pr-${subject.number}-fixes-${segment(jobId, 8)}`;
}

/**
 * Refuse fix targets the runner must not push to (before any agent runs).
 * Fixes on fork PRs are refused entirely, whatever the target: a fix commit
 * sits on top of the fork author's commits, and pushing those anywhere in the
 * base repo would run the fork's code (e.g. a push-triggered workflow) with
 * the base repo's secrets. `maintainerCanModify` / `headRepository` stay in
 * the contract but are not acted on.
 */
export function checkFixTarget(subject: PrJobSubject, _fix: PrFixInput): void {
  if (subject.isFork) {
    throw new PrJobError(
      "fork_fix_refused",
      `Fixes are not available for pull requests from forks (${subject.headRef} lives in a fork). Nothing was changed or pushed.`,
    );
  }
}

/** Target branch of a fix, validated (git ref rules, not the PR's own branches for new_branch). */
export async function fixTargetBranch(repoRoot: string, subject: PrJobSubject, fix: PrFixInput, jobId: string): Promise<string> {
  const branch = fix.target === "same_branch" ? subject.headRef : fix.newBranchName?.trim() || defaultFixBranchName(subject, jobId);
  const valid =
    isSafeBranchName(branch) && (await git(repoRoot, ["check-ref-format", "--branch", branch]).then(() => true, () => false));
  if (!valid) throw new PrJobError("invalid_branch", `"${String(branch).slice(0, 200)}" is not a valid branch name`);
  if (fix.target === "new_branch" && (branch === subject.headRef || branch === subject.baseRef)) {
    throw new PrJobError("invalid_branch", `A new branch for the fix cannot be named ${branch} (it is the pull request's own head or base)`);
  }
  return branch;
}

/** new_branch: the branch must not exist on the remote yet (a plain push would otherwise move it). */
export async function assertRemoteBranchAbsent(
  repoRoot: string,
  remote: string,
  branch: string,
  opts: SafeGitOptions = {},
): Promise<void> {
  let out: GitResult;
  try {
    out = await git(repoRoot, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], { timeoutMs: 60_000, ...opts, auth: true });
  } catch (err) {
    throw new PrJobError("push_rejected", `Checking ${branch} on ${remote} failed: ${gitErrorMessage(err)}`);
  }
  if (out.stdout.trim()) {
    throw new PrJobError("branch_exists", `Branch ${branch} already exists on ${remote}; nothing was pushed.`);
  }
}

// ---- fix: change-set checks ----------------------------------------------------

/** Plausibility caps of a fix change set (refused above them). */
export const FIX_MAX_FILES = 100;
export const FIX_MAX_LINES = 5000;
/** At most this many files are listed in the completion summary. */
export const FIX_SUMMARY_MAX_FILES = 40;
/** …and at most this many characters. */
export const FIX_SUMMARY_MAX_CHARS = 2000;

/**
 * Paths a fix may never touch: CI / workflow definitions and git config that
 * runs on push or checkout. Matched case-insensitively against the
 * repo-relative path (directories: any path under them).
 */
export const PROTECTED_PATH_PREFIXES = [
  ".github/",
  ".gitlab/",
  ".circleci/",
  ".buildkite/",
  ".husky/",
  ".azure-pipelines/",
  ".woodpecker/",
  ".forgejo/",
  ".gitea/",
  ".devcontainer/",
] as const;
export const PROTECTED_PATHS = [
  ".gitlab-ci.yml",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "appveyor.yml",
  ".appveyor.yml",
  ".drone.yml",
  ".woodpecker.yml",
  "jenkinsfile",
  "cloudbuild.yaml",
  "cloudbuild.yml",
  ".pre-commit-config.yaml",
  ".gitmodules",
  ".gitattributes",
  ".lfsconfig",
  ".gitconfig",
] as const;

export function isProtectedPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (PROTECTED_PATH_PREFIXES.some((d) => p.startsWith(d))) return true;
  const base = p.split("/").pop() ?? p;
  // Root-level CI files; .gitattributes / .gitmodules anywhere.
  return (PROTECTED_PATHS as readonly string[]).includes(p) || base === ".gitattributes" || base === ".gitmodules" || base === ".lfsconfig";
}

export interface FixFileChange {
  path: string;
  /** git status letter: A(dded), M(odified), D(eleted), T(ype change). */
  status: string;
  added: number;
  deleted: number;
  binary: boolean;
}

export interface FixChangeSet {
  files: FixFileChange[];
  added: number;
  deleted: number;
}

/** Parse `git diff --raw -z` + `--numstat -z` (renames off) into a change set. */
export function parseFixChanges(raw: string, numstat: string): FixChangeSet & { modes: Map<string, string> } {
  const modes = new Map<string, string>();
  const statusOf = new Map<string, string>();
  const rawParts = raw.split("\0");
  for (let i = 0; i + 1 < rawParts.length; i += 2) {
    const meta = rawParts[i] ?? "";
    const p = rawParts[i + 1] ?? "";
    const m = /^:(\d{6}) (\d{6}) \S+ \S+ ([A-Z])/.exec(meta.trim());
    if (!m || !p) continue;
    modes.set(p, m[2] as string);
    statusOf.set(p, m[3] as string);
  }
  const files: FixFileChange[] = [];
  let added = 0;
  let deleted = 0;
  for (const rec of numstat.split("\0")) {
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const p = m[3] as string;
    const binary = m[1] === "-" || m[2] === "-";
    const a = binary ? 0 : Number(m[1]);
    const d = binary ? 0 : Number(m[2]);
    added += a;
    deleted += d;
    files.push({ path: p, status: statusOf.get(p) ?? "M", added: a, deleted: d, binary });
  }
  return { files, added, deleted, modes };
}

/** Refuse implausible or dangerous fix change sets. Returns the reasons (empty = fine). */
export function fixChangeProblems(set: FixChangeSet & { modes: Map<string, string> }): string[] {
  const problems: string[] = [];
  const list = (paths: string[]) => paths.slice(0, 10).join(", ") + (paths.length > 10 ? ` (+${paths.length - 10} more)` : "");
  const outside = set.files.filter((f) => path.isAbsolute(f.path) || f.path.split("/").includes("..")).map((f) => f.path);
  if (outside.length) problems.push(`paths outside the repository: ${list(outside)}`);
  const protectedPaths = set.files.filter((f) => isProtectedPath(f.path)).map((f) => f.path);
  if (protectedPaths.length) problems.push(`changes to protected CI / git config paths (refused): ${list(protectedPaths)}`);
  const binaries = set.files.filter((f) => f.binary && f.status !== "D").map((f) => f.path);
  if (binaries.length) problems.push(`binary files: ${list(binaries)}`);
  const links = set.files.filter((f) => f.status !== "D" && ["120000", "160000"].includes(set.modes.get(f.path) ?? "")).map((f) => f.path);
  if (links.length) problems.push(`symbolic links or submodules: ${list(links)}`);
  if (set.files.length > FIX_MAX_FILES) problems.push(`${set.files.length} files changed (limit ${FIX_MAX_FILES})`);
  if (set.added + set.deleted > FIX_MAX_LINES) problems.push(`${set.added + set.deleted} lines changed (limit ${FIX_MAX_LINES})`);
  return problems;
}

/** Bounded human-readable list of a change set for the completion summary. */
export function formatFixChanges(set: FixChangeSet): string {
  const head = `Changed ${set.files.length} file(s), +${set.added} -${set.deleted}:`;
  const out = [head];
  let size = head.length;
  let listed = 0;
  for (const f of set.files) {
    if (listed >= FIX_SUMMARY_MAX_FILES) break;
    const line = `- ${f.path.slice(0, 160)} (${f.binary ? "binary" : `+${f.added} -${f.deleted}`}${f.status === "A" ? ", new" : f.status === "D" ? ", deleted" : ""})`;
    if (size + line.length + 1 > FIX_SUMMARY_MAX_CHARS) break;
    out.push(line);
    size += line.length + 1;
    listed++;
  }
  if (listed < set.files.length) out.push(`- … and ${set.files.length - listed} more file(s)`);
  return out.join("\n");
}

// ---- fix: commit and push ----------------------------------------------------

export interface PrFixResult {
  branch: string;
  commitSha: string;
  commitCount: number;
  /** The runner built the commit from the agent's working-tree changes (always true). */
  committedByRunner: boolean;
  changes: FixChangeSet;
}

export interface FinishPrFixOptions {
  jobId: string;
  /** Commit message of the fix commit. */
  commitMessage: string;
  pushTimeoutMs?: number;
  /** Abort (cancel): stops before the push, or kills an in-flight push. */
  signal?: AbortSignal;
}

const FALLBACK_IDENTITY = { name: "Flaio", email: "noreply@flaio.ai" };

/** Fail unless the repo config still matches the checkout snapshot (security-relevant keys). */
export async function assertRepoConfigUnchanged(checkout: PrCheckout): Promise<void> {
  if (!checkout.repoConfig) return;
  const now = await snapshotRepoConfig(checkout.repoRoot, checkout.gitDir ? { gitDir: checkout.gitDir } : {});
  const changed = changedSensitiveKeys(checkout.repoConfig, now);
  if (changed.length) {
    throw new PrJobError(
      "config_tampered",
      `The repository's git config changed while the agent ran (${changed.slice(0, 10).join(", ")}); nothing was pushed.`,
    );
  }
}

/**
 * After a pr_fix agent finished: build exactly one commit on top of the PR
 * head from what the agent changed in the working tree (a fresh index read
 * from the head; never the agent's own commits, HEAD or index; never .flaio
 * or neutralised symlinks), check the change set (caps, binaries, protected
 * paths, links), then push it to the target branch WITHOUT force. A rejected
 * push fails with git's message; the commit is kept under
 * `refs/flaio/unpushed/<pr>` so it is not lost when the worktree goes.
 */
export async function finishPrFix(
  checkout: PrCheckout,
  subject: PrJobSubject,
  fix: PrFixInput,
  opts: FinishPrFixOptions,
): Promise<PrFixResult> {
  checkFixTarget(subject, fix);
  const wt = checkout.worktreePath;
  const branch = await fixTargetBranch(checkout.repoRoot, subject, fix, opts.jobId);
  const aborted = () => {
    if (opts.signal?.aborted) throw new PrJobError("cancelled", "The fix was cancelled before pushing; nothing was pushed.", false);
  };
  aborted();
  await assertRepoConfigUnchanged(checkout);

  // Placeholders of neutralised symlinks must come back untouched.
  for (const rel of checkout.neutralisedLinks ?? []) {
    const abs = path.join(wt, rel);
    const st = await fsp.lstat(abs).catch(() => null);
    const content = st?.isFile() ? await fsp.readFile(abs, "utf-8").catch(() => null) : null;
    if (!content?.startsWith("flaio: this path is a symbolic link")) {
      throw new PrJobError("unsafe_changes", `The fix changed ${rel}, a symbolic link pointing outside the repository; nothing was pushed.`);
    }
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flaio-fix-"));
  const index = path.join(tmp, "index");
  const g = (args: string[], extra: Omit<SafeGitOptions, "gitDir" | "workTree" | "trusted"> = {}) =>
    git(wt, args, wtGit(checkout, { ...extra, env: { GIT_INDEX_FILE: index, ...(extra.env ?? {}) } }));
  let commitSha: string;
  let changes: FixChangeSet;
  try {
    let parsed: ReturnType<typeof parseFixChanges>;
    try {
      await g(["read-tree", checkout.headSha]);
      await g(["add", "-A"]);
      // .flaio (Flaio's workspace; a .flaio the PR tracks was removed from the
      // tree) and neutralised symlinks keep the head's version, whatever the
      // PR's .gitignore says.
      const keep = [":(literal).flaio", ...(checkout.neutralisedLinks ?? []).map((p) => `:(literal)${p}`)];
      const specFile = path.join(tmp, "pathspec");
      await fsp.writeFile(specFile, keep.join("\0") + "\0", { mode: 0o600 });
      await g(["reset", "-q", checkout.headSha, `--pathspec-from-file=${specFile}`, "--pathspec-file-nul"]);
      const raw = await g(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", checkout.headSha]);
      const numstat = await g(["diff", "--cached", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", checkout.headSha]);
      parsed = parseFixChanges(raw.stdout, numstat.stdout);
    } catch (err) {
      throw new PrJobError("commit_failed", `Collecting the fix failed: ${gitErrorMessage(err)}`);
    }
    if (parsed.files.length === 0) throw new PrJobError("no_changes", "The agent finished without changing anything; nothing was pushed.");
    const problems = fixChangeProblems(parsed);
    if (problems.length) {
      throw new PrJobError("unsafe_changes", `The fix was refused, nothing was pushed: ${problems.join("; ")}.\n\n${formatFixChanges(parsed)}`);
    }
    changes = { files: parsed.files, added: parsed.added, deleted: parsed.deleted };
    try {
      const tree = (await g(["write-tree"])).stdout.trim();
      const hasIdentity = (checkout.trusted?.common ?? []).some((c) => c.startsWith("user.name=")) &&
        (checkout.trusted?.common ?? []).some((c) => c.startsWith("user.email="));
      const identityEnv: Record<string, string> = hasIdentity
        ? {}
        : {
            GIT_AUTHOR_NAME: FALLBACK_IDENTITY.name,
            GIT_AUTHOR_EMAIL: FALLBACK_IDENTITY.email,
            GIT_COMMITTER_NAME: FALLBACK_IDENTITY.name,
            GIT_COMMITTER_EMAIL: FALLBACK_IDENTITY.email,
          };
      const msgFile = path.join(tmp, "message");
      await fsp.writeFile(msgFile, opts.commitMessage, { mode: 0o600 });
      commitSha = (await g(["commit-tree", tree, "-p", checkout.headSha, "-F", msgFile], { env: identityEnv })).stdout.trim();
    } catch (err) {
      throw new PrJobError("commit_failed", `Committing the fix failed: ${gitErrorMessage(err)}`);
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  if (!SHA_RE.test(commitSha)) throw new PrJobError("commit_failed", "Committing the fix produced no commit");

  aborted();
  if (fix.target === "new_branch") {
    try {
      await assertRemoteBranchAbsent(checkout.repoRoot, checkout.remote, branch, repoGit(checkout));
    } catch (err) {
      const kept = await keepUnpushed(checkout, subject, commitSha);
      if (err instanceof PrJobError && kept) err.message += ` (commit kept locally at ${kept})`;
      throw err;
    }
  }
  aborted();

  try {
    // Push the commit by sha (never HEAD, never "+": no force).
    await git(
      checkout.repoRoot,
      ["push", "--no-verify", "--porcelain", "--no-recurse-submodules", checkout.remote, `${commitSha}:refs/heads/${branch}`],
      repoGit(checkout, { auth: true, timeoutMs: opts.pushTimeoutMs ?? 180_000, signal: opts.signal }),
    );
  } catch (err) {
    if (opts.signal?.aborted) {
      const pushed = await remoteBranchAt(checkout, branch, commitSha);
      throw new PrJobError(
        "cancelled",
        pushed === true
          ? `Cancelled while pushing, but the push had already completed: ${branch} is at ${commitSha.slice(0, 12)}.`
          : pushed === false
            ? `Cancelled while pushing; the push was stopped and ${branch} was not updated.`
            : `Cancelled while pushing; could not confirm whether ${branch} was updated.`,
        pushed,
      );
    }
    const kept = await keepUnpushed(checkout, subject, commitSha);
    throw new PrJobError(
      "push_rejected",
      `Push to ${checkout.remote} ${branch} was rejected: ${gitErrorMessage(err)}${kept ? ` (commit kept locally at ${kept})` : ""}`,
    );
  }
  debugLog(`pr-jobs: pushed ${commitSha} to ${checkout.remote} ${branch}`);
  return { branch, commitSha, commitCount: 1, committedByRunner: true, changes };
}

/** Whether `branch` on the remote points at `sha` (null = could not tell). */
async function remoteBranchAt(checkout: PrCheckout, branch: string, sha: string): Promise<boolean | null> {
  try {
    const out = await git(checkout.repoRoot, ["ls-remote", "--heads", checkout.remote, `refs/heads/${branch}`], repoGit(checkout, { auth: true, timeoutMs: 30_000 }));
    const remoteSha = out.stdout.trim().split(/\s+/)[0] ?? "";
    return remoteSha.toLowerCase() === sha.toLowerCase();
  } catch {
    return null;
  }
}

/** Keep an unpushed fix commit under one ref per PR (overwritten by the next failure). */
async function keepUnpushed(checkout: PrCheckout, subject: PrJobSubject, sha: string): Promise<string | null> {
  const ref = `refs/flaio/unpushed/${prCheckoutPrefix(subject).replace(/-$/, "")}`;
  try {
    await git(checkout.repoRoot, ["update-ref", ref, sha], repoGit(checkout));
    return ref;
  } catch {
    return null;
  }
}
