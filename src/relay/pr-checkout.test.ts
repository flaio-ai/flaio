import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrJobSubject } from "../contracts/agent-loop.js";
import {
  checkFixTarget,
  checkoutPr,
  cleanupPrCheckout,
  finishPrFix,
  fixTargetBranch,
  FIX_MAX_FILES,
  isSafeBranchName,
  PrJobError,
  prCheckoutName,
  prCheckoutPrefix,
  remoteMatchesRepo,
  resolvePrRepo,
  sweepStalePrCheckouts,
  writePrDiff,
} from "./pr-checkout.js";
import { EMPTY_TRUSTED_CONFIG, resetTrustedGitConfigForTests } from "./safe-git.js";

// These tests run real git against temporary repositories (1-2 s each alone);
// under a fully parallel suite the default 5 s limit is occasionally too tight.
vi.setConfig({ testTimeout: 30_000 });

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
  resetTrustedGitConfigForTests(EMPTY_TRUSTED_CONFIG);
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

  it("refuses a run that changed nothing", async () => {
    const co = await checkout();
    const none = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, { jobId: "job1", commitMessage: "Fix" }).catch(
      (e: unknown) => e,
    );
    expect((none as PrJobError).code).toBe("no_changes");
    expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(fx.headSha);
    await cleanupPrCheckout(co);
  });

  it("pushes exactly one commit on top of the PR head with the working-tree changes, ignoring the agent's own commits and HEAD", async () => {
    const co = await checkout();
    // The agent commits something else and moves HEAD around...
    fs.writeFileSync(path.join(co.worktreePath, "smuggled.ts"), "x\n");
    g(co.worktreePath, "add", "smuggled.ts");
    g(co.worktreePath, "commit", "-m", "smuggled");
    const agentCommit = g(co.worktreePath, "rev-parse", "HEAD");
    fs.rmSync(path.join(co.worktreePath, "smuggled.ts"));
    g(co.worktreePath, "reset", "-q", "--hard", `${agentCommit}~2`);
    // ...and leaves this in the working tree.
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 8;\n");
    const res = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, { jobId: "job1", commitMessage: "Fix" });
    expect(g(fx.bare, "rev-parse", `${res.commitSha}^`)).toBe(fx.headSha);
    expect(g(fx.bare, "rev-list", "--count", `${fx.headSha}..${res.commitSha}`)).toBe("1");
    expect(g(fx.bare, "diff", "--name-only", fx.headSha, res.commitSha)).toBe("app.ts");
    expect(() => g(fx.bare, "cat-file", "-e", agentCommit)).toThrow(); // never pushed
    expect(res.changes.files).toEqual([{ path: "app.ts", status: "M", added: 1, deleted: 1, binary: false }]);
    await cleanupPrCheckout(co);
  });

  it("refuses every fix on a fork PR, whatever the target or maintainer flag", async () => {
    const fork = { ...fx.subject, isFork: true };
    for (const fix of [
      { findingIds: [], target: "same_branch" as const },
      { findingIds: [], target: "new_branch" as const },
      { findingIds: [], target: "same_branch" as const, maintainerCanModify: true, headRepository: "contrib/widgets" },
      { findingIds: [], target: "new_branch" as const, maintainerCanModify: true, headRepository: "contrib/widgets" },
    ]) {
      expect(() => checkFixTarget(fork, fix)).toThrow(/forks/);
    }
    // finishPrFix re-checks: nothing is pushed even if a fork checkout got this far.
    const co = await checkout();
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 10;\n");
    const err = await finishPrFix(co, fork, { findingIds: [], target: "new_branch", newBranchName: "fix/x" }, { jobId: "j", commitMessage: "F" }).catch(
      (e: unknown) => e,
    );
    expect((err as PrJobError).code).toBe("fork_fix_refused");
    expect(() => g(fx.bare, "rev-parse", "--verify", "refs/heads/fix/x")).toThrow();
    await cleanupPrCheckout(co);
  });

  it("refuses changes to workflows and other protected paths, naming them, and pushes nothing", async () => {
    const co = await checkout();
    fs.mkdirSync(path.join(co.worktreePath, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(co.worktreePath, ".github", "workflows", "ci.yml"), "on: push\n");
    fs.writeFileSync(path.join(co.worktreePath, ".gitattributes"), "* filter=x\n");
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 11;\n");
    const err = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, { jobId: "j", commitMessage: "F" }).catch(
      (e: unknown) => e,
    );
    expect((err as PrJobError).code).toBe("unsafe_changes");
    expect((err as Error).message).toContain(".github/workflows/ci.yml");
    expect((err as Error).message).toContain(".gitattributes");
    expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(fx.headSha);
    await cleanupPrCheckout(co);
  });

  it("refuses implausible change sets: too many files, binaries, new symlinks", async () => {
    const tryFix = async (prep: (wt: string) => void) => {
      const co = await checkout();
      prep(co.worktreePath);
      const err = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, { jobId: "j", commitMessage: "F" }).catch(
        (e: unknown) => e,
      );
      await cleanupPrCheckout(co);
      return err as PrJobError;
    };
    const many = await tryFix((wt) => {
      for (let i = 0; i <= FIX_MAX_FILES; i++) fs.writeFileSync(path.join(wt, `f${i}.ts`), "x\n");
    });
    expect(many.code).toBe("unsafe_changes");
    expect(many.message).toContain(`limit ${FIX_MAX_FILES}`);
    const binary = await tryFix((wt) => fs.writeFileSync(path.join(wt, "blob.bin"), Buffer.from([0, 1, 2, 0, 255])));
    expect(binary.message).toMatch(/binary files: blob\.bin/);
    const link = await tryFix((wt) => fs.symlinkSync("/etc/passwd", path.join(wt, "passwd")));
    expect(link.message).toMatch(/symbolic links or submodules: passwd/);
    expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(fx.headSha);
  });

  it("refuses to push when the repo's git config gained a program-executing key after checkout, without running it", async () => {
    const co = await checkout();
    const marker = path.join(fx.tmp, "fsmonitor-ran");
    const hook = path.join(fx.tmp, "fsmon.sh");
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    g(fx.clone, "config", "core.fsmonitor", hook); // what a hostile agent would write
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 12;\n");
    const err = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, { jobId: "j", commitMessage: "F" }).catch(
      (e: unknown) => e,
    );
    expect((err as PrJobError).code).toBe("config_tampered");
    expect((err as Error).message).toContain("core.fsmonitor");
    expect(fs.existsSync(marker)).toBe(false);
    expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(fx.headSha);
    g(fx.clone, "config", "--unset", "core.fsmonitor");
    await cleanupPrCheckout(co);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("ignores a global gitconfig and a repointed worktree .git written by the agent (fsmonitor never runs)", async () => {
    const co = await checkout();
    const marker = path.join(fx.tmp, "fsmonitor-ran");
    const hook = path.join(fx.tmp, "fsmon.sh");
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    // A hostile ~/.gitconfig: plain git would run the fsmonitor (also with -c core.hooksPath=/dev/null).
    const evilGlobal = path.join(fx.tmp, "evil-gitconfig");
    fs.writeFileSync(evilGlobal, `[core]\n\tfsmonitor = ${hook}\n`);
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "status", "--porcelain"], {
      cwd: co.worktreePath,
      env: { ...process.env, GIT_CONFIG_GLOBAL: evilGlobal },
      stdio: "ignore",
    });
    expect(fs.existsSync(marker)).toBe(true); // the attack works against plain git
    fs.rmSync(marker);
    // The worktree's .git file repointed at a git dir with its own fsmonitor config.
    const fake = path.join(fx.tmp, "fakegit");
    g(fx.tmp, "init", "-q", "--bare", fake);
    fs.appendFileSync(path.join(fake, "config"), `[core]\n\tfsmonitor = ${hook}\n`);
    fs.writeFileSync(path.join(co.worktreePath, ".git"), `gitdir: ${fake}\n`);
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 13;\n");
    process.env.GIT_CONFIG_GLOBAL = evilGlobal;
    try {
      const res = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, { jobId: "j", commitMessage: "F" });
      expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(res.commitSha);
      expect(g(fx.bare, "rev-parse", `${res.commitSha}^`)).toBe(fx.headSha);
      expect(res.changes.files.map((f) => f.path)).toEqual(["app.ts"]);
      await cleanupPrCheckout(co);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("validates branch names from job input before using them in refspecs", async () => {
    expect(isSafeBranchName("feature/x-1.2")).toBe(true);
    for (const bad of ["-x", "+main", "a..b", "a:b", "a b", "a~1", "a^", "a\\b", "x.lock", "/x", "x/", "@", "a@{1}", "", "ä"]) {
      expect(isSafeBranchName(bad)).toBe(false);
    }
    const { match } = await resolvePrRepo(fx.subject, [fx.clone]);
    for (const subject of [
      { ...fx.subject, baseRef: "main:refs/heads/evil" },
      { ...fx.subject, headRef: "-evil" },
      { ...fx.subject, number: 7.5 },
      { ...fx.subject, headSha: "--upload-pack=x" },
    ]) {
      const err = await checkoutPr(match, subject, opts()).catch((e: unknown) => e);
      expect((err as PrJobError).code).toBe("invalid_subject");
    }
    expect(g(fx.clone, "for-each-ref", "refs/flaio/")).toBe("");
    // same_branch uses the PR's head ref: validated too.
    const err = await fixTargetBranch(fx.clone, { ...fx.subject, headRef: "x:y" }, { findingIds: [], target: "same_branch" }, "j").catch(
      (e: unknown) => e,
    );
    expect((err as PrJobError).code).toBe("invalid_branch");
  });

  it("aborts an in-flight push on cancel and reports truthfully that nothing was pushed", async () => {
    // A slow transport: ssh to the bare repo through a wrapper that waits before receive-pack.
    const wrapper = path.join(fx.tmp, "slow-ssh.sh");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\ncase "$*" in *receive-pack*) sleep 4; exec git-receive-pack '${fx.bare}';; *) exec git-upload-pack '${fx.bare}';; esac\n`,
      { mode: 0o755 },
    );
    g(fx.clone, "remote", "set-url", "--push", "origin", "ssh://slow.invalid/acme/widgets.git");
    const co = await checkout();
    fs.writeFileSync(path.join(co.worktreePath, "app.ts"), "export const a = 14;\n");
    process.env.GIT_SSH_COMMAND = wrapper;
    const ac = new AbortController();
    try {
      const started = Date.now();
      setTimeout(() => ac.abort(), 700);
      const err = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, {
        jobId: "j",
        commitMessage: "F",
        signal: ac.signal,
      }).catch((e: unknown) => e);
      expect((err as PrJobError).code).toBe("cancelled");
      expect((err as PrJobError).pushed).toBe(false);
      expect((err as Error).message).toMatch(/not updated/);
      expect(Date.now() - started).toBeLessThan(3500);
    } finally {
      delete process.env.GIT_SSH_COMMAND;
    }
    expect(g(fx.bare, "rev-parse", "refs/heads/feature")).toBe(fx.headSha);
    // Already cancelled before the push: nothing is attempted.
    const pre = new AbortController();
    pre.abort();
    const err2 = await finishPrFix(co, fx.subject, { findingIds: [], target: "same_branch" }, { jobId: "j", commitMessage: "F", signal: pre.signal }).catch(
      (e: unknown) => e,
    );
    expect((err2 as PrJobError).code).toBe("cancelled");
    expect((err2 as PrJobError).pushed).toBe(false);
    await cleanupPrCheckout(co);
  });
});

describe("worktree names", () => {
  it("cannot escape the worktrees directory whatever the job id, attempt or subject say", () => {
    const name = prCheckoutName({ owner: "../..", repo: "x/../../y", number: 7 }, "../../../etc", 1);
    expect(name).toMatch(/^pr-[a-z0-9-]+$/);
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    const hostile = prCheckoutName({ owner: "a", repo: "b", number: "1/../../x" as unknown as number }, "j", "../2" as unknown as number);
    expect(hostile).toMatch(/^pr-[a-z0-9-]+$/);
  });
});

describe("checkoutPr: hostile PR content", () => {
  /** Push a new PR head built by `prep` in the seed (on top of the feature branch) as refs/pull/7/head. */
  function pushPrHead(prep: (seed: string) => void): PrJobSubject {
    prep(fx.seed);
    g(fx.seed, "add", "-A");
    g(fx.seed, "commit", "-q", "-m", "hostile");
    g(fx.seed, "push", "-q", "origin", "HEAD:refs/heads/feature");
    const headSha = g(fx.seed, "rev-parse", "HEAD");
    g(fx.bare, "update-ref", "refs/pull/7/head", headSha);
    return { ...fx.subject, headSha };
  }

  it("replaces symlinks that leave the worktree (absolute, relative, directory, chained, .flaio) and keeps in-tree ones", async () => {
    const outside = path.join(fx.tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    const subject = pushPrHead((seed) => {
      fs.mkdirSync(path.join(seed, "docs"));
      fs.writeFileSync(path.join(seed, "docs", "real.md"), "real\n");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(seed, "abs-link"));
      fs.symlinkSync("../../../outside/secret.txt", path.join(seed, "docs", "rel-link"));
      fs.symlinkSync(outside, path.join(seed, "dir-link"));
      fs.symlinkSync("real.md", path.join(seed, "docs", "ok-link"));
      fs.symlinkSync("docs", path.join(seed, "docs-link"));
      fs.symlinkSync("dir-link/secret.txt", path.join(seed, "chain-link")); // via another escaping link
      fs.symlinkSync(outside, path.join(seed, ".flaio"));
    });
    const { match } = await resolvePrRepo(subject, [fx.clone]);
    const co = await checkoutPr(match, subject, opts());
    const wt = co.worktreePath;
    expect([...(co.neutralisedLinks ?? [])].sort()).toEqual(["abs-link", "chain-link", "dir-link", "docs/rel-link"]);
    for (const p of co.neutralisedLinks ?? []) {
      expect(fs.lstatSync(path.join(wt, p)).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(wt, p), "utf-8")).toMatch(/^flaio: this path is a symbolic link/);
    }
    expect(fs.readlinkSync(path.join(wt, "docs", "ok-link"))).toBe("real.md");
    expect(fs.readlinkSync(path.join(wt, "docs-link"))).toBe("docs");
    expect(fs.existsSync(path.join(wt, ".flaio"))).toBe(false); // the PR's .flaio link is gone, the target untouched
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf-8")).toBe("secret\n");
    // The runner's own writes land in a real directory inside the worktree.
    const diffFile = (await writePrDiff(co, subject)) as string;
    expect(fs.realpathSync(diffFile).startsWith(fs.realpathSync(wt) + path.sep)).toBe(true);
    expect(fs.readdirSync(outside)).toEqual(["secret.txt"]);

    // A fix neither pushes the placeholders nor may change them.
    fs.writeFileSync(path.join(wt, "app.ts"), "export const a = 20;\n");
    const res = await finishPrFix(co, subject, { findingIds: [], target: "same_branch" }, { jobId: "j", commitMessage: "F" });
    expect(g(fx.bare, "diff", "--name-only", subject.headSha, res.commitSha)).toBe("app.ts");
    expect(g(fx.bare, "cat-file", "-p", `${res.commitSha}:abs-link`)).toBe(path.join(outside, "secret.txt"));
    await cleanupPrCheckout(co);

    const co2 = await checkoutPr(match, subject, opts("job2"));
    fs.writeFileSync(path.join(co2.worktreePath, "abs-link"), "changed\n");
    const err = await finishPrFix(co2, subject, { findingIds: [], target: "same_branch" }, { jobId: "j2", commitMessage: "F" }).catch(
      (e: unknown) => e,
    );
    expect((err as PrJobError).code).toBe("unsafe_changes");
    expect((err as Error).message).toContain("abs-link");
    await cleanupPrCheckout(co2);
  });

  it("never runs filter drivers from the repo config, and never fetches submodules, even with submodule.recurse", async () => {
    const marker = path.join(fx.tmp, "filter-ran");
    const subRemote = path.join(fx.tmp, "attacker-sub.git");
    g(fx.tmp, "init", "-q", "--bare", subRemote);
    const subject = pushPrHead((seed) => {
      fs.writeFileSync(path.join(seed, ".gitattributes"), "*.ts filter=evil\n");
      fs.writeFileSync(path.join(seed, ".gitmodules"), `[submodule "sub"]\n\tpath = sub\n\turl = ${subRemote}\n`);
      g(seed, "update-index", "--add", "--cacheinfo", `160000,${fx.headSha},sub`);
      fs.writeFileSync(path.join(seed, "b.ts"), "export const b = 1;\n");
    });
    // The user's repo config defines a program filter and recursion; the PR's .gitattributes activates it.
    g(fx.clone, "config", "filter.evil.smudge", `sh -c 'echo smudge >> "${marker}"; cat'`);
    g(fx.clone, "config", "filter.evil.clean", `sh -c 'echo clean >> "${marker}"; cat'`);
    g(fx.clone, "config", "submodule.recurse", "true");
    const { match } = await resolvePrRepo(subject, [fx.clone]);
    const co = await checkoutPr(match, subject, opts());
    expect(fs.readFileSync(path.join(co.worktreePath, "b.ts"), "utf-8")).toBe("export const b = 1;\n");
    const sub = path.join(co.worktreePath, "sub");
    expect(fs.existsSync(sub) ? fs.readdirSync(sub) : []).toEqual([]);
    fs.writeFileSync(path.join(co.worktreePath, "b.ts"), "export const b = 2;\n");
    await finishPrFix(co, subject, { findingIds: [], target: "same_branch" }, { jobId: "j", commitMessage: "F" });
    await cleanupPrCheckout(co);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("deepens a shallow single-branch clone until head and base share a merge base, so a diff is produced", async () => {
    // main moves 80 commits ahead of where the PR branched off.
    g(fx.seed, "checkout", "-q", "main");
    for (let i = 0; i < 80; i++) {
      fs.writeFileSync(path.join(fx.seed, "log.txt"), `${i}\n`);
      g(fx.seed, "add", "log.txt");
      g(fx.seed, "commit", "-q", "-m", `main ${i}`);
    }
    g(fx.seed, "push", "-q", "origin", "main");
    // Cloud-runner style clone: shallow, single branch, file:// so --depth applies.
    const shallow = path.join(fx.tmp, "shallow", "widgets");
    g(fx.tmp, "clone", "-q", "--depth", "5", "--single-branch", "--no-tags", `file://${fx.bare}`, shallow);
    expect(g(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    const { match } = await resolvePrRepo(fx.subject, [shallow]);
    const co = await checkoutPr(match, fx.subject, opts());
    expect(co.mergeBase).toBeTruthy();
    const diffFile = await writePrDiff(co, fx.subject);
    expect(diffFile).not.toBeNull();
    const diff = fs.readFileSync(diffFile as string, "utf-8");
    expect(diff).toContain("+export const a = 2;");
    expect(diff).not.toContain("log.txt"); // against the merge base, not main's tip
    await cleanupPrCheckout(co);
  });
});
