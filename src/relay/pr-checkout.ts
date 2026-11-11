// ---------------------------------------------------------------------------
// Pull request checkouts for pr_review / pr_fix jobs (local runner)
//
//   resolvePrRepo   — find a tracked project dir whose git remote is the PR's
//                     owner/repo (never clones; no match fails the job)
//   checkoutPr      — fetch pull/<n>/head (+ the base branch) into private
//                     refs/flaio/* refs, verify the head sha, add a detached
//                     worktree under .flaio/worktrees/ (user's checkout untouched)
//   writePrDiff     — .flaio/ticket/pr.diff for the agent (size-capped)
//   finishPrFix     — commit what the agent changed, verify, push (never force)
//   cleanupPrCheckout / sweepStalePrCheckouts — remove worktrees and refs
//
// Every git call here runs with repo hooks disabled: the worktree holds
// untrusted PR content (husky-style core.hooksPath would otherwise run it).
// ---------------------------------------------------------------------------

import { execFile as execFileCb } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PrFixInput, PrJobSubject } from "../contracts/agent-loop.js";
import { writePrWorkspaceFile } from "../workspace/ticket-workspace.js";
import { makeDebugLog } from "../connectors/debug.js";
import { normalizeRepoUrl } from "./runner-info.js";
import {
  addDetachedWorktree,
  ensureFlaioExcluded,
  flaioWorktreesDir,
  listFlaioWorktreePaths,
  NO_HOOKS_CONFIG,
  removeDetachedWorktree,
} from "./worktree-manager.js";

const execFile = promisify(execFileCb);
const debugLog = makeDebugLog("pr-jobs");

export type PrJobErrorCode =
  | "no_checkout"
  | "fetch_failed"
  | "head_moved"
  | "fork_same_branch"
  | "invalid_branch"
  | "branch_exists"
  | "no_changes"
  | "history_rewritten"
  | "commit_failed"
  | "push_rejected";

/** A PR job failure with a message meant for the user (sent as cli_job_failed.error). */
export class PrJobError extends Error {
  constructor(
    readonly code: PrJobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PrJobError";
  }
}

// ---- git -------------------------------------------------------------------

export interface GitResult {
  stdout: string;
  stderr: string;
}

const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Run git with repo hooks disabled and no interactive credential prompts. */
export async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  const { stdout, stderr } = await execFile("git", [...NO_HOOKS_CONFIG, ...args], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** stderr (or message) of a failed git call, credentials scrubbed and size-capped. */
export function gitErrorMessage(err: unknown, max = 1500): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const raw = (typeof e?.stderr === "string" && e.stderr.trim()) || (typeof e?.message === "string" ? e.message : String(err));
  const scrubbed = raw
    .replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***")
    .trim();
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
}

// ---- repo resolution -------------------------------------------------------

export interface GitRemote {
  name: string;
  url: string;
}

/** Fetch remotes of a project dir (empty when it is not a repo). */
export async function listRemotes(cwd: string): Promise<GitRemote[]> {
  try {
    const { stdout } = await execFile("git", ["remote", "-v"], { cwd, timeout: 5000 });
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
    const { stdout } = await execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      timeout: 5000,
    });
    const dir = stdout.trim();
    return dir ? await fsp.realpath(dir).catch(() => dir) : null;
  } catch {
    return null;
  }
}

/** Top level of the working tree that holds `cwd`. */
async function repoTopLevel(cwd: string): Promise<string> {
  const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
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
  return `pr-${segment(subject.owner, 30)}-${segment(subject.repo, 40)}-${subject.number}-`;
}

/** Worktree / ref name of one job attempt. */
export function prCheckoutName(
  subject: Pick<PrJobSubject, "owner" | "repo" | "number">,
  jobId: string,
  attempt: number,
): string {
  return `${prCheckoutPrefix(subject)}${segment(jobId, 12)}-${attempt}`;
}

export interface PrCheckout {
  repoRoot: string;
  remote: string;
  /** URL of `remote` (a same-branch fix on a maintainer-editable fork pushes to the fork's URL built from it). */
  remoteUrl?: string;
  /** Worktree / ref name (see prCheckoutName). */
  name: string;
  worktreePath: string;
  /** Private refs: `<refBase>/head`, `<refBase>/base`. */
  refBase: string;
  headSha: string;
  /** Tip of the fetched base branch; null when it could not be fetched. */
  baseSha: string | null;
}

function shaMatches(actual: string, expected: string): boolean {
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  return e.length >= 7 && (a === e || a.startsWith(e));
}

async function deleteRefs(repoRoot: string, refs: string[]): Promise<void> {
  for (const ref of refs) {
    await git(repoRoot, ["update-ref", "-d", ref]).catch(() => undefined);
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

/**
 * Fetch the PR head (and base) from the matching remote into private refs,
 * verify the head is `subject.headSha`, and add a detached worktree at it.
 * Never touches the user's working tree, branches or current HEAD.
 */
export async function checkoutPr(match: PrRepoMatch, subject: PrJobSubject, opts: CheckoutPrOptions): Promise<PrCheckout> {
  const { repoRoot, remote } = match;
  const name = prCheckoutName(subject, opts.jobId, opts.attempt);
  const refBase = `refs/flaio/${name}`;
  await sweepStalePrCheckouts(repoRoot, prCheckoutPrefix(subject), new Set([...opts.activeNames, name]));

  const timeout = opts.fetchTimeoutMs ?? 180_000;
  try {
    await git(
      repoRoot,
      ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/pull/${subject.number}/head:${refBase}/head`],
      timeout,
    );
  } catch (err) {
    await deleteRefs(repoRoot, [`${refBase}/head`]);
    throw new PrJobError("fetch_failed", `Fetching pull/${subject.number}/head from ${remote} failed: ${gitErrorMessage(err)}`);
  }
  const headSha = (await git(repoRoot, ["rev-parse", `${refBase}/head^{commit}`])).stdout.trim();
  if (!shaMatches(headSha, subject.headSha)) {
    await deleteRefs(repoRoot, [`${refBase}/head`]);
    throw new PrJobError(
      "head_moved",
      `The pull request head moved: the job is for ${subject.headSha.slice(0, 12)} but ${remote} now has ${headSha.slice(0, 12)}. Start a new run on the current head.`,
    );
  }

  let baseSha: string | null = null;
  try {
    await git(
      repoRoot,
      ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${subject.baseRef}:${refBase}/base`],
      timeout,
    );
    baseSha = (await git(repoRoot, ["rev-parse", `${refBase}/base^{commit}`])).stdout.trim() || null;
  } catch (err) {
    debugLog(`pr-jobs: fetching base ${subject.baseRef} failed (diff unavailable): ${gitErrorMessage(err)}`);
  }

  let worktreePath: string;
  try {
    // Keep .flaio/ (worktrees, workspace files) out of the user's `git status`.
    await ensureFlaioExcluded(repoRoot);
    worktreePath = await addDetachedWorktree(repoRoot, name, headSha);
  } catch (err) {
    await deleteRefs(repoRoot, [`${refBase}/head`, `${refBase}/base`]);
    throw new Error(`Creating the review worktree failed: ${gitErrorMessage(err)}`, { cause: err });
  }
  // A .flaio directory shipped by the PR must not shadow (or redirect) the
  // workspace Flaio writes; rm removes a symlink itself, never its target.
  await fsp.rm(path.join(worktreePath, ".flaio"), { recursive: true, force: true }).catch(() => undefined);

  debugLog(`pr-jobs: checked out ${subject.owner}/${subject.repo}#${subject.number} at ${headSha} in ${worktreePath}`);
  return { repoRoot, remote, remoteUrl: match.remoteUrl, name, worktreePath, refBase, headSha, baseSha };
}

/** Remove the job's worktree and private refs. Safe to call more than once. */
export async function cleanupPrCheckout(checkout: Pick<PrCheckout, "repoRoot" | "worktreePath" | "refBase">): Promise<void> {
  await removeDetachedWorktree(checkout.repoRoot, checkout.worktreePath).catch((err) =>
    debugLog(`pr-jobs: removing ${checkout.worktreePath} failed: ${gitErrorMessage(err)}`),
  );
  await deleteRefs(checkout.repoRoot, [`${checkout.refBase}/head`, `${checkout.refBase}/base`]);
}

// ---- diff for the agent ----------------------------------------------------

export const PR_DIFF_MAX_BYTES = 1_500_000;

/** Write `.flaio/ticket/pr.diff`: commits, stat and the diff against the merge base (capped). */
export async function writePrDiff(checkout: PrCheckout, subject: PrJobSubject, maxBytes = PR_DIFF_MAX_BYTES): Promise<string | null> {
  if (!checkout.baseSha) return null;
  const range = `${checkout.baseSha}...${checkout.headSha}`;
  const wt = checkout.worktreePath;
  try {
    const log = await git(wt, ["log", "--no-color", "--oneline", "--max-count=200", `${checkout.baseSha}..${checkout.headSha}`]);
    const stat = await git(wt, ["diff", "--no-color", "--no-ext-diff", "--stat", range]);
    const diff = await git(wt, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", range]);
    let body = diff.stdout;
    let truncated = false;
    if (Buffer.byteLength(body, "utf-8") > maxBytes) {
      body = Buffer.from(body, "utf-8").subarray(0, maxBytes).toString("utf-8");
      truncated = true;
    }
    const header = [
      `# ${subject.owner}/${subject.repo}#${subject.number}: ${subject.headRef} -> ${subject.baseRef}`,
      `# head ${checkout.headSha}  base ${subject.baseRef} @ ${checkout.baseSha}`,
      "#",
      "# Commits:",
      ...log.stdout.trimEnd().split("\n").filter(Boolean).map((l) => `#   ${l}`),
      "#",
      ...stat.stdout.trimEnd().split("\n").map((l) => `# ${l}`),
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

const REPO_FULL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Whether a same-branch fix may push to the fork the PR comes from: the server
 * checked the live PR allows edits by maintainers (`maintainerCanModify`) and
 * named the fork (`headRepository`).
 */
export function forkSameBranchAllowed(subject: PrJobSubject, fix: PrFixInput): boolean {
  return (
    subject.isFork &&
    fix.target === "same_branch" &&
    fix.maintainerCanModify === true &&
    typeof fix.headRepository === "string" &&
    REPO_FULL_NAME_RE.test(fix.headRepository) &&
    !fix.headRepository.includes("/.")
  );
}

/**
 * The fork's URL in the style of the base remote (ssh stays ssh, https stays
 * https, same host): the last `owner/repo` of `remoteUrl` replaced by `headRepository`.
 */
export function forkPushUrl(remoteUrl: string, headRepository: string): string {
  const url = remoteUrl.trim();
  const replaced = url.replace(/([:/])[^/:]+\/[^/]+?(?:\.git)?\/?$/, `$1${headRepository}.git`);
  if (replaced === url) throw new PrJobError("push_rejected", `Cannot derive the fork's URL from ${url}`);
  return replaced;
}

/** Refuse fix targets the runner cannot push to (before any agent runs). */
export function checkFixTarget(subject: PrJobSubject, fix: PrFixInput): void {
  if (fix.target === "same_branch" && subject.isFork && !forkSameBranchAllowed(subject, fix)) {
    throw new PrJobError(
      "fork_same_branch",
      `Cannot push to the pull request's own branch: ${subject.headRef} lives in a fork that does not allow edits by maintainers. Use "fix in a new branch" instead.`,
    );
  }
}

/** Target branch of a fix, validated (git ref rules, not the PR's own branches for new_branch). */
export async function fixTargetBranch(repoRoot: string, subject: PrJobSubject, fix: PrFixInput, jobId: string): Promise<string> {
  if (fix.target === "same_branch") return subject.headRef;
  const branch = fix.newBranchName?.trim() || defaultFixBranchName(subject, jobId);
  const valid = !branch.startsWith("-") && (await git(repoRoot, ["check-ref-format", "--branch", branch]).then(() => true, () => false));
  if (!valid) throw new PrJobError("invalid_branch", `"${branch}" is not a valid branch name`);
  if (branch === subject.headRef || branch === subject.baseRef) {
    throw new PrJobError("invalid_branch", `A new branch for the fix cannot be named ${branch} (it is the pull request's own head or base)`);
  }
  return branch;
}

/** new_branch: the branch must not exist on the remote yet (a plain push would otherwise move it). */
export async function assertRemoteBranchAbsent(repoRoot: string, remote: string, branch: string): Promise<void> {
  let out: GitResult;
  try {
    out = await git(repoRoot, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], 60_000);
  } catch (err) {
    throw new PrJobError("push_rejected", `Checking ${branch} on ${remote} failed: ${gitErrorMessage(err)}`);
  }
  if (out.stdout.trim()) {
    throw new PrJobError("branch_exists", `Branch ${branch} already exists on ${remote}; nothing was pushed.`);
  }
}

export interface PrFixResult {
  branch: string;
  commitSha: string;
  commitCount: number;
  /** The runner committed changes the agent left uncommitted. */
  committedByRunner: boolean;
}

export interface FinishPrFixOptions {
  jobId: string;
  /** Commit message used when the runner commits the agent's changes. */
  commitMessage: string;
  pushTimeoutMs?: number;
}

/**
 * After a pr_fix agent finished: commit what it left uncommitted (never the
 * .flaio workspace), check there are new commits on top of the PR head and
 * that history was not rewritten, then push to the target branch WITHOUT
 * force. A rejected push fails with git's message; the commits are kept under
 * `refs/flaio/unpushed/<pr>` so they are not lost when the worktree goes.
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

  let committedByRunner = false;
  const status = await git(wt, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).flaio"]);
  if (status.stdout.trim()) {
    try {
      // Stage everything, then unstage .flaio (Flaio's workspace, and any
      // .flaio the PR itself tracks, which checkoutPr removed from the tree).
      await git(wt, ["add", "-A"]);
      await git(wt, ["reset", "-q", "HEAD", "--", ".flaio"]);
      await git(wt, ["commit", "--no-verify", "--no-gpg-sign", "-m", opts.commitMessage]);
      committedByRunner = true;
    } catch (err) {
      throw new PrJobError("commit_failed", `Committing the fix failed: ${gitErrorMessage(err)}`);
    }
  }

  const commitSha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
  const isDescendant = await git(wt, ["merge-base", "--is-ancestor", checkout.headSha, "HEAD"]).then(
    () => true,
    () => false,
  );
  if (!isDescendant) {
    throw new PrJobError("history_rewritten", "The fix rewrote the pull request's history (HEAD no longer contains the PR head); nothing was pushed.");
  }
  const commitCount = parseInt((await git(wt, ["rev-list", "--count", `${checkout.headSha}..HEAD`])).stdout.trim(), 10) || 0;
  if (commitCount === 0) {
    throw new PrJobError("no_changes", "The agent finished without changing anything; nothing was pushed.");
  }

  if (fix.target === "new_branch") {
    try {
      await assertRemoteBranchAbsent(checkout.repoRoot, checkout.remote, branch);
    } catch (err) {
      const kept = await keepUnpushed(checkout, subject);
      if (err instanceof PrJobError && kept) err.message += ` (commits kept locally at ${kept})`;
      throw err;
    }
  }

  // Same branch of a maintainer-editable fork: push to the fork, not the base repo.
  let pushTo = checkout.remote;
  if (forkSameBranchAllowed(subject, fix) && fix.headRepository) {
    if (!checkout.remoteUrl) throw new PrJobError("push_rejected", "The base remote's URL is unknown; cannot push to the fork.");
    pushTo = forkPushUrl(checkout.remoteUrl, fix.headRepository);
  }
  try {
    await git(wt, ["push", "--no-verify", "--porcelain", pushTo, `HEAD:refs/heads/${branch}`], opts.pushTimeoutMs ?? 180_000);
  } catch (err) {
    const kept = await keepUnpushed(checkout, subject);
    throw new PrJobError(
      "push_rejected",
      `Push to ${pushTo === checkout.remote ? checkout.remote : fix.headRepository} ${branch} was rejected: ${gitErrorMessage(err)}${kept ? ` (commits kept locally at ${kept})` : ""}`,
    );
  }
  debugLog(`pr-jobs: pushed ${commitCount} commit(s) ${commitSha} to ${pushTo === checkout.remote ? checkout.remote : fix.headRepository} ${branch}`);
  return { branch, commitSha, commitCount, committedByRunner };
}

/** Keep unpushed fix commits under one ref per PR (overwritten by the next failure). */
async function keepUnpushed(checkout: PrCheckout, subject: PrJobSubject): Promise<string | null> {
  const ref = `refs/flaio/unpushed/${prCheckoutPrefix(subject).replace(/-$/, "")}`;
  try {
    await git(checkout.worktreePath, ["update-ref", ref, "HEAD"]);
    return ref;
  } catch {
    return null;
  }
}
