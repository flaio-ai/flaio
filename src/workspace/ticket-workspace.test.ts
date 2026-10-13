import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDecision,
  appendProgress,
  ensureExcluded,
  readWorkspace,
  recordAnswer,
  recordQuestion,
  resolveGitInfoDir,
  workspaceFilePath,
  writeBrief,
  writePlan,
} from "./ticket-workspace.js";

let tmp: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flaio-ws-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ticket workspace files", () => {
  it("writes brief and plan, appends decisions and progress", async () => {
    await writeBrief(tmp, "# Brief\nDo the thing", { ticketId: "t1", jobId: "j1" });
    await writePlan(tmp, "## Plan\n1. step");
    await appendDecision(tmp, { title: "Use zod", rationale: "Already a dependency" }, 0);
    await appendDecision(tmp, { title: "Second", rationale: "Because" }, 0);
    await appendProgress(tmp, { step: "step 1", status: "done", note: "ok" }, 0);
    await appendProgress(tmp, "Handoff: next do step 2", 0);

    const ws = await readWorkspace(tmp);
    expect(ws.brief).toBe("# Brief\nDo the thing\n");
    expect(ws.plan).toBe("## Plan\n1. step\n");
    expect(ws.decisions).toMatch(/^# Decisions\n/);
    expect(ws.decisions).toContain("## Use zod");
    expect(ws.decisions).toContain("## Second");
    expect(ws.decisions!.match(/# Decisions/g)).toHaveLength(1);
    expect(ws.progress).toContain("**done** step 1 — ok");
    expect(ws.progress).toContain("Handoff: next do step 2");
    expect(ws.state.ticketId).toBe("t1");
    expect(ws.state.jobId).toBe("j1");
    expect(typeof ws.state.phaseStartedAt).toBe("number");
  });

  it("returns nulls for a missing workspace", async () => {
    const ws = await readWorkspace(tmp);
    expect(ws).toMatchObject({ brief: null, plan: null, decisions: null, progress: null, openQuestions: [] });
  });

  it("records questions and answers", async () => {
    await recordQuestion(tmp, { questionId: "q1", text: "Which DB?\nPostgres or MySQL", blocking: true });
    await recordQuestion(tmp, { questionId: "q2", text: "Naming?", blocking: false });
    let ws = await readWorkspace(tmp);
    expect(ws.openQuestions).toEqual([
      { questionId: "q1", text: "Which DB?\nPostgres or MySQL" },
      { questionId: "q2", text: "Naming?" },
    ]);

    expect(await recordAnswer(tmp, "q1", "Postgres")).toBe(true);
    expect(await recordAnswer(tmp, "nope", "x")).toBe(false);
    ws = await readWorkspace(tmp);
    expect(ws.openQuestions).toEqual([{ questionId: "q2", text: "Naming?" }]);
    const q1 = ws.parsedQuestions.find((q) => q.questionId === "q1")!;
    expect(q1).toMatchObject({ status: "answered", answer: "Postgres", blocking: true, text: "Which DB?\nPostgres or MySQL" });
    expect(fs.readFileSync(workspaceFilePath(tmp, "questions"), "utf-8")).toContain("**Answer:** Postgres");
  });
});

describe("ensureExcluded", () => {
  it("returns null outside a git repo", async () => {
    expect(await ensureExcluded(tmp)).toBeNull();
  });

  it("adds .flaio/ to .git/info/exclude once", async () => {
    git(tmp, "init", "-q");
    const p = await ensureExcluded(tmp);
    await ensureExcluded(tmp);
    expect(p).toBe(path.join(tmp, ".git", "info", "exclude"));
    const content = fs.readFileSync(p!, "utf-8");
    expect(content.split("\n").filter((l) => l === ".flaio/")).toHaveLength(1);
  });

  it("handles a linked worktree whose .git is a file (writes to the common dir)", async () => {
    const main = path.join(tmp, "main");
    fs.mkdirSync(main);
    git(main, "init", "-q");
    fs.writeFileSync(path.join(main, "a.txt"), "a");
    git(main, "add", ".");
    git(main, "commit", "-qm", "init");
    const wt = path.join(tmp, "wt");
    git(main, "worktree", "add", "-q", "-b", "ticket/x", wt);

    expect(fs.statSync(path.join(wt, ".git")).isFile()).toBe(true);
    expect(fs.realpathSync((await resolveGitInfoDir(wt))!)).toBe(fs.realpathSync(path.join(main, ".git")));

    await writeBrief(wt, "brief");
    // git itself must now ignore the workspace in the worktree
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(git(wt, "check-ignore", ".flaio/ticket/brief.md").trim()).toBe(".flaio/ticket/brief.md");
  });
});
