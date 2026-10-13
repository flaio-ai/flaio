import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorktreeRemovable, cleanupTickets, DAY_MS, type WorktreeCheck } from "./ticket-cleanup.js";
import { TicketTracker, type TrackedTicket } from "./ticket-tracker.js";

const NOW = 100 * DAY_MS;

function entry(patch: Partial<TrackedTicket>): Partial<TrackedTicket> {
  return { status: "done", ticketTitle: "T", originalCwd: "", worktreePath: null, branchName: null, ...patch };
}

function makeTracker(entries: Record<string, Partial<TrackedTicket>>): TicketTracker {
  const t = new TicketTracker({ filePath: null });
  for (const [id, e] of Object.entries(entries)) t.upsert(id, e);
  // upsert stamps updatedAt=now; restore the fixture's value.
  for (const [id, e] of Object.entries(entries)) {
    const cur = t.get(id);
    if (cur) cur.updatedAt = e.updatedAt;
  }
  return t;
}

describe("cleanupTickets", () => {
  const safe = async (): Promise<WorktreeCheck> => ({ safe: true });

  it("removes only idle tickets past retention", async () => {
    const tracker = makeTracker({
      old: entry({ lastJobFinishedAt: NOW - 20 * DAY_MS }),
      recent: entry({ lastJobFinishedAt: NOW - 2 * DAY_MS }),
      oldByUpdatedAt: entry({ updatedAt: NOW - 30 * DAY_MS }),
      unknownAge: entry({}),
      busy: entry({ lastJobFinishedAt: NOW - 20 * DAY_MS }),
      live: entry({ lastJobFinishedAt: NOW - 20 * DAY_MS, sessionId: "pty-1" }),
    });
    const res = await cleanupTickets(
      { tracker, isBusy: (id) => id === "busy", now: () => NOW, checkWorktree: safe },
      { retentionMs: 14 * DAY_MS },
    );
    expect(res.removed.sort()).toEqual(["old", "oldByUpdatedAt"]);
    expect([...tracker.getAll().keys()].sort()).toEqual(["busy", "live", "recent", "unknownAge"]);
  });

  it("never removes a worktree with unsaved work", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flaio-cleanup-"));
    try {
      const tracker = makeTracker({ t1: entry({ worktreePath: dir, lastJobFinishedAt: 0 }) });
      const res = await cleanupTickets(
        { tracker, isBusy: () => false, now: () => NOW, checkWorktree: async () => ({ safe: false, reason: "uncommitted changes" }) },
        { retentionMs: DAY_MS },
      );
      expect(res).toEqual({ removed: [], kept: [{ ticketId: "t1", reason: "uncommitted changes" }] });
      expect(tracker.get("t1")).toBeDefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("`only` restricts the sweep (cancel for a done ticket)", async () => {
    const tracker = makeTracker({ a: entry({ lastJobFinishedAt: NOW }), b: entry({ lastJobFinishedAt: NOW }) });
    const res = await cleanupTickets(
      { tracker, isBusy: () => false, now: () => NOW, checkWorktree: safe },
      { retentionMs: 0, only: ["a", "missing"] },
    );
    expect(res.removed).toEqual(["a"]);
    expect(tracker.get("b")).toBeDefined();
  });
});

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("checkWorktreeRemovable (real git)", () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    })
      .toString()
      .trim();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "flaio-cleanup-git-"));
    git(root, "init", "-q", "--bare", "remote.git");
    git(root, "init", "-q", "work");
    const work = path.join(root, "work");
    await fs.writeFile(path.join(work, "a.txt"), "a");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "init");
    git(work, "remote", "add", "origin", path.join(root, "remote.git"));
    git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("clean and pushed → safe", async () => {
    expect(await checkWorktreeRemovable(path.join(root, "work"))).toEqual({ safe: true });
  });

  it("uncommitted or untracked changes → unsafe", async () => {
    const work = path.join(root, "work");
    await fs.writeFile(path.join(work, "new.txt"), "x");
    expect(await checkWorktreeRemovable(work)).toEqual({ safe: false, reason: "uncommitted changes" });
  });

  it("ignored files (the .flaio workspace) do not block removal", async () => {
    const work = path.join(root, "work");
    await fs.appendFile(path.join(work, ".git/info/exclude"), "\n.flaio/\n");
    await fs.mkdir(path.join(work, ".flaio/ticket"), { recursive: true });
    await fs.writeFile(path.join(work, ".flaio/ticket/brief.md"), "# B");
    expect(await checkWorktreeRemovable(work)).toEqual({ safe: true });
  });

  it("commits on no remote → unsafe", async () => {
    const work = path.join(root, "work");
    await fs.writeFile(path.join(work, "b.txt"), "b");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "local only");
    expect(await checkWorktreeRemovable(work)).toEqual({ safe: false, reason: "1 commit(s) not on any remote" });
  });

  it("not a repo → unsafe", async () => {
    expect((await checkWorktreeRemovable(root)).safe).toBe(false);
  });
});
