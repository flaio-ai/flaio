import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrJobSubject } from "../contracts/agent-loop.js";
import {
  checkFixTarget,
  checkoutPr,
  forkPushUrl,
  cleanupPrCheckout,
  finishPrFix,
  PrJobError,
  prCheckoutPrefix,
  remoteMatchesRepo,
  resolvePrRepo,
  sweepStalePrCheckouts,
  writePrDiff,
} from "./pr-checkout.js";

// ---------------------------------------------------------------------------
// Real git fixture: a bare "GitHub" remote at <tmp>/remotes/acme/widgets.git
// with main, a PR branch and refs/pull/7/head; the user's clone of it.
// ---------------------------------------------------------------------------

const savedEnv = { ...process.env };
beforeAll(() => {
  // Isolate from the developer's git config (signing, hooks, templates).
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});
afterAll(() => {
  process.env = savedEnv;
});

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture {
  tmp: string;
  bare: string;
  seed: string;
  clone: string;
  headSha: string;
  subject: PrJobSubject;
}

function makeFixture(): Fixture {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flaio-pr-")));
  const bare = path.join(tmp, "remotes", "acme", "widgets.git");
  fs.mkdirSync(bare, { recursive: true });
  g(bare, "init", "--bare", "-b", "main");
  const seed = path.join(tmp, "seed");
  g(tmp, "clone", bare, seed);
  fs.writeFileSync(path.join(seed, "app.ts"), "export const a = 1;\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-m", "init");
  g(seed, "push", "origin", "HEAD:refs/heads/main");
  g(seed, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(seed, "app.ts"), "export const a = 2;\n");
  g(seed, "commit", "-am", "change a");
  g(seed, "push", "origin", "feature");
  const headSha = g(seed, "rev-parse", "HEAD");
  g(bare, "update-ref", "refs/pull/7/head", headSha);
  const clone = path.join(tmp, "home", "widgets");
  g(tmp, "clone", bare, clone);
  return {
    tmp,
    bare,
    seed,
    clone,
    headSha,
    subject: { type: "pr", owner: "acme", repo: "widgets", number: 7, headSha, headRef: "feature", baseRef: "main", isFork: false },
  };
}

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => {
  fs.rmSync(fx.tmp, { recursive: true, force: true });
});

const opts = (jobId = "job1", attempt = 1) => ({ jobId, attempt, activeNames: new Set<string>() });

describe("remoteMatchesRepo", () => {
  it("matches ssh, https, host aliases and local paths ending in owner/repo", () => {
    expect(remoteMatchesRepo("git@github.com:Acme/Widgets.git", "acme", "widgets")).toBe(true);
    expect(remoteMatchesRepo("https://x-access-token:t@github.com/acme/widgets", "ACME", "Widgets")).toBe(true);
    expect(remoteMatchesRepo("github-work:acme/widgets.git", "acme", "widgets")).toBe(true);
    expect(remoteMatchesRepo("/srv/git/acme/widgets.git", "acme", "widgets")).toBe(true);
    expect(remoteMatchesRepo("git@github.com:acme/widgets-old.git", "acme", "widgets")).toBe(false);
    expect(remoteMatchesRepo("git@github.com:other/widgets.git", "acme", "widgets")).toBe(false);
  });
});

describe("resolvePrRepo", () => {
  it("finds the tracked clone whose remote is the PR's repo", async () => {
    const { match, others } = await resolvePrRepo(fx.subject, [path.join(fx.tmp, "nope"), fx.clone]);
    expect(match).toMatchObject({ repoRoot: fx.clone, remote: "origin", cwd: fx.clone });
    expect(others).toEqual([]);
  });

  it("fails clearly when no tracked dir is a clone of the repo (never clones)", async () => {
    const err = await resolvePrRepo({ owner: "acme", repo: "gadgets" }, [fx.clone]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrJobError);
    expect((err as PrJobError).code).toBe("no_checkout");
    expect((err as Error).message).toContain("no checkout of acme/gadgets");
    await expect(resolvePrRepo(fx.subject, [])).rejects.toThrow(/no checkout of acme\/widgets/);
  });

  it("with several clones: counts linked worktrees once and picks the first tracked clone", async () => {
    const second = path.join(fx.tmp, "home", "widgets-2");
    g(fx.tmp, "clone", fx.bare, second);
    const linked = path.join(fx.tmp, "home", "widgets-linked");
    g(fx.clone, "worktree", "add", "-b", "side", linked);
    const { match, others } = await resolvePrRepo(fx.subject, [linked, fx.clone, second]);
    expect(match.repoRoot).toBe(fx.clone);
    expect(match.cwd).toBe(linked);
    expect(others.map((o) => o.repoRoot)).toEqual([second]);
  });

  it("prefers origin, then upstream, among matching remotes; ignores non-matching ones", async () => {
    const { match } = await resolvePrRepo(fx.subject, [fx.clone], {
      listRemotes: async () => [
        { name: "zeta", url: "git@github.com:acme/widgets.git" },
        { name: "origin", url: "git@github.com:me/widgets.git" },
        { name: "upstream", url: "https://github.com/acme/widgets.git" },
      ],
    });
    expect(match.remote).toBe("upstream");
  });
});

describe("checkoutPr", () => {
  it("fetches the PR head into a detached worktree without touching the user's checkout", async () => {
    const before = { head: g(fx.clone, "rev-parse", "HEAD"), branch: g(fx.clone, "branch", "--show-current") };
    const { match } = await resolvePrRepo(fx.subject, [fx.clone]);
    const co = await checkoutPr(match, fx.subject, opts());
    expect(co.headSha).toBe(fx.headSha);
    expect(co.worktreePath.startsWith(path.join(fx.clone, ".flaio", "worktrees", prCheckoutPrefix(fx.subject)))).toBe(true);
    expect(fs.readFileSync(path.join(co.worktreePath, "app.ts"), "utf-8")).toBe("export const a = 2;\n");
    expect(g(co.worktreePath, "rev-parse", "HEAD")).toBe(fx.headSha);
    expect(g(co.worktreePath, "branch", "--show-current")).toBe(""); // detached
    expect(co.baseSha).toBe(g(fx.seed, "rev-parse", "main"));
    // The user's own checkout: same HEAD, same branch, clean, no new branches.
    expect(g(fx.clone, "rev-parse", "HEAD")).toBe(before.head);
    expect(g(fx.clone, "branch", "--show-current")).toBe(before.branch);
    expect(g(fx.clone, "status", "--porcelain")).toBe("");
    expect(g(fx.clone, "branch", "--format=%(refname:short)")).toBe(before.branch);

    const diffFile = await writePrDiff(co, fx.subject);
    const diff = fs.readFileSync(diffFile as string, "utf-8");
    expect(diff).toContain("acme/widgets#7: feature -> main");
    expect(diff).toContain("+export const a = 2;");

    await cleanupPrCheckout(co);
    expect(fs.existsSync(co.worktreePath)).toBe(false);
    expect(g(fx.clone, "for-each-ref", "refs/flaio/")).toBe("");
    expect(g(fx.clone, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("fails with head_moved when the PR head is not the job's sha, leaving nothing behind", async () => {
    const { match } = await resolvePrRepo(fx.subject, [fx.clone]);
    const err = await checkoutPr(match, { ...fx.subject, headSha: "0123456789abcdef0123456789abcdef01234567" }, opts()).catch(
      (e: unknown) => e,
    );
    expect((err as PrJobError).code).toBe("head_moved");
    expect((err as Error).message).toMatch(/head moved/);
    expect(g(fx.clone, "for-each-ref", "refs/flaio/")).toBe("");
    expect(fs.existsSync(path.join(fx.clone, ".flaio", "worktrees")) ? fs.readdirSync(path.join(fx.clone, ".flaio", "worktrees")) : []).toEqual([]);
  });

  it("never runs the repo's git hooks (husky-style core.hooksPath)", async () => {
    const hooks = path.join(fx.tmp, "hooks");
    fs.mkdirSync(hooks);
    const marker = path.join(fx.tmp, "hook-ran");
    for (const h of ["post-checkout", "pre-commit", "post-commit", "pre-push"]) {
      fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\necho ${h} >> "${marker}"\n`, { mode: 0o755 });
    }
    g(fx.clone, "config", "core.hooksPath", hooks);
    const { match } = await resolvePrRepo(fx.subject, [fx.clone]);
    const co = await checkoutPr(match, fx.subject, opts());
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 3;\n");
    await finishPrFix(co, fx.subject, { findingIds: ["f1"], target: "same_branch" }, { jobId: "job1", commitMessage: "Fix" });
    await cleanupPrCheckout(co);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("sweeps worktrees and refs left behind by earlier jobs of the same PR only", async () => {
    const { match } = await resolvePrRepo(fx.subject, [fx.clone]);
    const old = await checkoutPr(match, fx.subject, opts("crashed", 1));
    const other = await checkoutPr(match, { ...fx.subject, number: 8 }, opts("other", 1)).catch(() => null); // no pull/8: fails
    expect(other).toBeNull();
    // A stray directory (crash between mkdir and worktree add) is swept too.
    fs.mkdirSync(path.join(fx.clone, ".flaio", "worktrees", `${prCheckoutPrefix(fx.subject)}stray-1`));
    const fresh = await checkoutPr(match, fx.subject, opts("job2", 1));
    expect(fs.existsSync(old.worktreePath)).toBe(false);
    const names = fs.readdirSync(path.join(fx.clone, ".flaio", "worktrees")).filter((n) => n.startsWith("pr-"));
    expect(names).toEqual([path.basename(fresh.worktreePath)]);
    expect(g(fx.clone, "for-each-ref", "--format=%(refname)", "refs/flaio/").split("\n").sort()).toEqual(
      [`${fresh.refBase}/base`, `${fresh.refBase}/head`].sort(),
    );
    // A live job's checkout is never swept.
    await sweepStalePrCheckouts(fx.clone, prCheckoutPrefix(fx.subject), new Set([fresh.name]));
    expect(fs.existsSync(fresh.worktreePath)).toBe(true);
    await cleanupPrCheckout(fresh);
  });
});

describe("finishPrFix", () => {
  async function checkout(subject = fx.subject) {
    const { match } = await resolvePrRepo(subject, [fx.clone]);
    return checkoutPr(match, subject, opts());
  }

  it("same_branch: commits the agent's changes (not .flaio) and pushes to the PR branch", async () => {
    const co = await checkout();
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 3;\n");
    fs.mkdirSync(path.join(co.worktreePath, ".flaio", "ticket"), { recursive: true });
    fs.writeFileSync(path.join(co.worktreePath, ".flaio", "ticket", "brief.md"), "# brief\n");
    const res = await finishPrFix(co, fx.subject, { findingIds: ["f1"], target: "same_branch" }, {
      jobId: "job1",
      commitMessage: "Apply review fixes",
    });
    expect(res).toMatchObject({ branch: "feature", commitCount: 1, committedByRunner: true });
    expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(res.commitSha);
    expect(g(fx.bare, "show", "--name-only", "--format=%s", res.commitSha).split("\n")).toEqual(["Apply review fixes", "", "app.ts"]);
    await cleanupPrCheckout(co);
  });

  it("new_branch: pushes a new branch from the PR head and refuses an existing one", async () => {
    const co = await checkout();
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 4;\n");
    const res = await finishPrFix(co, fx.subject, { findingIds: ["f1"], target: "new_branch", newBranchName: "fix/pr-7" }, {
      jobId: "job1",
      commitMessage: "Fix",
    });
    expect(res.branch).toBe("fix/pr-7");
    expect(g(fx.bare, "rev-parse", "refs/heads/fix/pr-7")).toBe(res.commitSha);
    expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(fx.headSha); // PR branch untouched
    await cleanupPrCheckout(co);

    const co2 = await checkout();
    fs.writeFileSync(path.join(co2.worktreePath, "app.ts"), "export const a = 5;\n");
    const err = await finishPrFix(co2, fx.subject, { findingIds: ["f1"], target: "new_branch", newBranchName: "fix/pr-7" }, {
      jobId: "job2",
      commitMessage: "Fix",
    }).catch((e: unknown) => e);
    expect((err as PrJobError).code).toBe("branch_exists");
    expect(g(fx.bare, "rev-parse", "refs/heads/fix/pr-7")).toBe(res.commitSha);
    await cleanupPrCheckout(co2);
  });

  it("uses a safe default name and rejects invalid or PR-own branch names", async () => {
    const co = await checkout();
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 6;\n");
    for (const bad of ["main", "feature", "bad..name", "-x"]) {
      const err = await finishPrFix(co, fx.subject, { findingIds: [], target: "new_branch", newBranchName: bad }, {
        jobId: "job1",
        commitMessage: "Fix",
      }).catch((e: unknown) => e);
      expect((err as PrJobError).code).toBe("invalid_branch");
    }
    const res = await finishPrFix(co, fx.subject, { findingIds: [], target: "new_branch" }, { jobId: "Job_ABC123", commitMessage: "Fix" });
    expect(res.branch).toBe("flaio/pr-7-fixes-job-abc1");
    await cleanupPrCheckout(co);
  });

  it("fails with git's message when the push is rejected (branch moved), keeping the commits", async () => {
    const co = await checkout();
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 7;\n");
    // Someone pushes to the PR branch meanwhile.
    fs.writeFileSync(path.join(fx.seed, "other.ts"), "x\n");
    g(fx.seed, "add", "-A");
    g(fx.seed, "commit", "-m", "concurrent");
    g(fx.seed, "push", "origin", "feature");
    const moved = g(fx.seed, "rev-parse", "HEAD");
    const err = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, { jobId: "job1", commitMessage: "Fix" }).catch(
      (e: unknown) => e,
    );
    expect((err as PrJobError).code).toBe("push_rejected");
    expect((err as Error).message).toMatch(/rejected/);
    expect((err as Error).message).toContain("refs/flaio/unpushed/");
    expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(moved); // never forced
    await cleanupPrCheckout(co);
    expect(g(fx.clone, "for-each-ref", "--format=%(refname)", "refs/flaio/unpushed/")).toContain("pr-acme-widgets-7");
  });

  it("refuses a run that changed nothing or rewrote the PR history", async () => {
    const co = await checkout();
    const none = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, { jobId: "job1", commitMessage: "Fix" }).catch(
      (e: unknown) => e,
    );
    expect((none as PrJobError).code).toBe("no_changes");
    g(co.worktreePath, "reset", "--hard", "HEAD~1");
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 8;\n");
    const rewritten = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, {
      jobId: "job1",
      commitMessage: "Fix",
    }).catch((e: unknown) => e);
    expect((rewritten as PrJobError).code).toBe("history_rewritten");
    expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(fx.headSha);
    await cleanupPrCheckout(co);
  });

  it("refuses same_branch for a fork head unless the server says maintainers may edit it", () => {
    const fork = { ...fx.subject, isFork: true };
    expect(() => checkFixTarget(fork, { findingIds: [], target: "same_branch" })).toThrow(/fork/);
    expect(() => checkFixTarget(fork, { findingIds: [], target: "new_branch" })).not.toThrow();
    // The flag alone is not enough: the fork's repository must be named, and valid.
    expect(() => checkFixTarget(fork, { findingIds: [], target: "same_branch", maintainerCanModify: true })).toThrow(/fork/);
    expect(() => checkFixTarget(fork, { findingIds: [], target: "same_branch", maintainerCanModify: true, headRepository: "../x" })).toThrow(/fork/);
    expect(() => checkFixTarget(fork, { findingIds: [], target: "same_branch", maintainerCanModify: false, headRepository: "contrib/widgets" })).toThrow(/fork/);
    expect(() => checkFixTarget(fork, { findingIds: [], target: "same_branch", maintainerCanModify: true, headRepository: "contrib/widgets" })).not.toThrow();
  });

  it("derives the fork's push URL in the base remote's style", () => {
    expect(forkPushUrl("git@github.com:acme/widgets.git", "contrib/widgets")).toBe("git@github.com:contrib/widgets.git");
    expect(forkPushUrl("https://github.com/acme/widgets", "contrib/widgets")).toBe("https://github.com/contrib/widgets.git");
    expect(forkPushUrl("ssh://git@github.com/acme/widgets.git/", "contrib/w")).toBe("ssh://git@github.com/contrib/w.git");
    expect(forkPushUrl("/srv/git/acme/widgets.git", "contrib/widgets")).toBe("/srv/git/contrib/widgets.git");
  });

  it("same_branch on a maintainer-editable fork pushes to the fork's branch, never the base repo", async () => {
    // The contributor's fork: a second bare repo next to the base one, holding the PR branch.
    const forkBare = path.join(fx.tmp, "remotes", "contrib", "widgets.git");
    fs.mkdirSync(forkBare, { recursive: true });
    g(forkBare, "init", "--bare", "-b", "main");
    g(fx.seed, "push", forkBare, "feature:refs/heads/feature");
    g(fx.bare, "update-ref", "-d", "refs/heads/feature"); // the base repo has only refs/pull/7/head
    const subject = { ...fx.subject, isFork: true };
    const fix = { findingIds: ["f1"], target: "same_branch" as const, maintainerCanModify: true, headRepository: "contrib/widgets" };
    const { match } = await resolvePrRepo(subject, [fx.clone]);
    const co = await checkoutPr(match, subject, opts());
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 10;\n");
    const res = await finishPrFix(co, subject, fix, { jobId: "job1", commitMessage: "Fix" });
    expect(res.branch).toBe("feature");
    expect(g(forkBare, "rev-parse", "refs/heads/feature")).toBe(res.commitSha);
    expect(() => g(fx.bare, "rev-parse", "--verify", "refs/heads/feature")).toThrow();
    await cleanupPrCheckout(co);
  });
});
