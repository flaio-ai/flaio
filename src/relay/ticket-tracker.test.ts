import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TicketTracker } from "./ticket-tracker.js";
import { ensureFlaioExcluded } from "./worktree-manager.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "flaio-tracker-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("TicketTracker persistence", () => {
  it("round-trips tickets, agent sessions and runner id through tickets.json", async () => {
    const file = path.join(dir, "tickets.json");
    const worktree = path.join(dir, "wt");
    await fs.mkdir(worktree);

    const a = new TicketTracker({ filePath: file });
    await a.load();
    a.startPlanning("t1", "session-1", "Fix login", dir, worktree, "ticket/t1");
    a.upsert("t1", { driverName: "claude", model: "claude-opus-4-6", useWorktree: true, lastJobKind: "plan" });
    a.setAgentSession(
      "t1",
      { id: "11111111-1111-4111-8111-111111111111", driver: "claude", resumeCount: 2, transcriptPath: "/x.jsonl" },
      worktree,
    );
    a.setActiveJob("t1", { id: "job1", kind: "plan", legacy: false, startedAt: 1 });
    const runnerId = a.getRunnerId();
    await a.flush();

    // Atomic write leaves no temp files behind.
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    const b = new TicketTracker({ filePath: file });
    await b.load();
    const entry = b.get("t1");
    expect(entry).toMatchObject({
      ticketTitle: "Fix login",
      originalCwd: dir,
      worktreePath: worktree,
      branchName: "ticket/t1",
      driverName: "claude",
      model: "claude-opus-4-6",
      useWorktree: true,
      lastJobKind: "plan",
      agentCwd: worktree,
      // In-flight state from the previous process is not trusted.
      sessionId: null,
      activeJob: null,
      status: "interrupted",
    });
    expect(b.getAgentSession("t1")).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      driver: "claude",
      resumeCount: 2,
      transcriptPath: "/x.jsonl",
    });
    expect(b.getRunnerId()).toBe(runnerId);
    expect(b.getSessionForTicket("t1")).toBeUndefined();
  });

  it("reconciles on load: drops entries whose worktree or project dir vanished", async () => {
    const file = path.join(dir, "tickets.json");
    const keep = path.join(dir, "keep");
    const gone = path.join(dir, "gone");
    await fs.mkdir(keep);
    await fs.mkdir(gone);

    const a = new TicketTracker({ filePath: file });
    a.startPlanning("keep", "s1", "K", dir, keep, "ticket/keep");
    a.startPlanning("gone", "s2", "G", dir, gone, "ticket/gone");
    a.startPlanning("nocwd", "s3", "N", path.join(dir, "missing-project"));
    a.updateStatus("keep", "done");
    await a.flush();
    await fs.rm(gone, { recursive: true });

    const b = new TicketTracker({ filePath: file });
    await b.load();
    expect([...b.getAll().keys()]).toEqual(["keep"]);
    expect(b.get("keep")?.status).toBe("done");
    await b.flush();

    // The reconciled state was written back.
    const onDisk = JSON.parse(await fs.readFile(file, "utf-8"));
    expect(Object.keys(onDisk.tickets)).toEqual(["keep"]);
  });

  it("ignores a corrupt file and starts empty", async () => {
    const file = path.join(dir, "tickets.json");
    await fs.writeFile(file, "{not json");
    const t = new TicketTracker({ filePath: file });
    await t.load();
    expect(t.getAll().size).toBe(0);
    expect(t.isLoaded).toBe(true);
  });

  it("maps sessions to tickets and clears them", () => {
    const t = new TicketTracker({ filePath: null });
    t.startPlanning("t1", "s1", "T", dir);
    expect(t.getTicketForSession("s1")).toBe("t1");
    t.startImplementation("t1", "s2");
    expect(t.getTicketForSession("s1")).toBeUndefined();
    expect(t.getSessionForTicket("t1")).toBe("s2");
    t.clearSession("t1", "s2");
    expect(t.getSessionForTicket("t1")).toBeUndefined();
    expect(t.nextPlanIteration("t1")).toBe(0);
    expect(t.nextPlanIteration("t1")).toBe(1);
  });
});

describe("ensureFlaioExcluded", () => {
  it("adds .flaio/ to info/exclude once, including from a linked worktree", async () => {
    const repo = path.join(dir, "repo");
    await fs.mkdir(repo);
    const git = (args: string[], cwd = repo) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });
    git(["init", "-q"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);
    const wt = path.join(dir, "wt");
    git(["worktree", "add", "-q", "-b", "ticket/x", wt]);

    expect(await ensureFlaioExcluded(wt)).toBe(true);
    expect(await ensureFlaioExcluded(repo)).toBe(true);
    const exclude = await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split("\n").filter((l) => l === ".flaio/")).toHaveLength(1);

    await fs.mkdir(path.join(wt, ".flaio", "ticket"), { recursive: true });
    await fs.writeFile(path.join(wt, ".flaio", "ticket", "brief.md"), "x");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf-8" }).trim()).toBe("");
  });

  it("is a no-op outside git", async () => {
    expect(await ensureFlaioExcluded(dir)).toBe(false);
  });
});
