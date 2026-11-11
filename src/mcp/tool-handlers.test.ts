import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TicketPhaseBus, type TicketPhaseBusEvent } from "../contracts/ticket-phase-bus.js";
import { readWorkspace, recordAnswer, writeBrief } from "../workspace/ticket-workspace.js";
import { handleMcpToolCall } from "./bridge.js";
import { _clearMcpSessions, registerMcpSession, revokeMcpSession } from "./session-registry.js";
import { handleToolCall, ToolInputError, type BusEmit } from "./tool-handlers.js";

let wt: string;
const events: { event: TicketPhaseBusEvent; payload: unknown }[] = [];
const emit: BusEmit = (event, payload) => {
  events.push({ event, payload });
};

beforeEach(() => {
  wt = fs.mkdtempSync(path.join(os.tmpdir(), "flaio-tools-test-"));
  events.length = 0;
  _clearMcpSessions();
});

afterEach(() => {
  fs.rmSync(wt, { recursive: true, force: true });
});

const ctx = () => ({ ticketId: "t1", jobId: "j1", worktreePath: wt });

describe("handleToolCall", () => {
  it("get_ticket_context reads the workspace", async () => {
    await writeBrief(wt, "# Brief");
    await handleToolCall(ctx(), "ask_question", { text: "Q?" }, { emit, newQuestionId: () => "q1" });
    await recordAnswer(wt, "q1", "A");
    await handleToolCall(ctx(), "ask_question", { text: "Q2?" }, { emit, newQuestionId: () => "q2" });
    const out = await handleToolCall(ctx(), "get_ticket_context", {});
    expect(out).toEqual({
      ticketId: "t1",
      briefMarkdown: "# Brief\n",
      planMarkdown: null,
      decisionsMarkdown: null,
      progressMarkdown: null,
      openQuestions: [{ questionId: "q2", text: "Q2?" }],
    });
  });

  it("get_ticket_context works with an empty workspace", async () => {
    const out = await handleToolCall(ctx(), "get_ticket_context", undefined);
    expect(out.briefMarkdown).toBe("");
  });

  it("submit_plan validates, applies defaults, persists and emits", async () => {
    const out = await handleToolCall(ctx(), "submit_plan", { steps: ["a"], markdown: "# Plan" }, { emit });
    expect(out).toEqual({ ok: true });
    expect((await readWorkspace(wt)).plan).toBe("# Plan\n");
    expect(events).toEqual([
      {
        event: "plan_submitted",
        payload: { ticketId: "t1", jobId: "j1", plan: { steps: ["a"], risks: [], files: [], markdown: "# Plan" } },
      },
    ]);
  });

  it("rejects invalid input without emitting or writing", async () => {
    await expect(handleToolCall(ctx(), "submit_plan", { steps: [], markdown: "" }, { emit })).rejects.toBeInstanceOf(
      ToolInputError,
    );
    await expect(handleToolCall(ctx(), "report_progress", { step: "x", status: "bogus" }, { emit })).rejects.toThrow(
      /status/,
    );
    await expect(handleToolCall(ctx(), "complete_phase", { result: "success" }, { emit })).rejects.toThrow(/summary/);
    expect(events).toEqual([]);
    expect((await readWorkspace(wt)).plan).toBeNull();
  });

  it("ask_question records and emits with a question id", async () => {
    const out = await handleToolCall(ctx(), "ask_question", { text: "Which?" }, { emit, newQuestionId: () => "q_abc" });
    expect(out).toEqual({ questionId: "q_abc" });
    expect(events[0]).toEqual({
      event: "question",
      payload: { ticketId: "t1", jobId: "j1", questionId: "q_abc", question: { text: "Which?", blocking: true } },
    });
    expect((await readWorkspace(wt)).openQuestions).toEqual([{ questionId: "q_abc", text: "Which?" }]);
  });

  it("record_decision, report_progress and complete_phase persist and emit", async () => {
    await handleToolCall(ctx(), "record_decision", { title: "T", rationale: "R" }, { emit });
    await handleToolCall(ctx(), "report_progress", { step: "s1", status: "started" }, { emit });
    await handleToolCall(ctx(), "complete_phase", { result: "success", summary: "All done", testsRun: ["vitest"] }, { emit });
    expect(events.map((e) => e.event)).toEqual(["decision", "progress", "phase_complete"]);
    expect(events[2].payload).toEqual({
      ticketId: "t1",
      jobId: "j1",
      completion: { result: "success", summary: "All done", testsRun: ["vitest"] },
    });
    const ws = await readWorkspace(wt);
    expect(ws.decisions).toContain("## T");
    expect(ws.progress).toContain("**started** s1");
    expect(ws.progress).toContain("Phase complete (success)");
    expect(ws.progress).toContain("- vitest");
  });
});

describe("handleMcpToolCall (CLI endpoint)", () => {
  it("refuses unknown tokens", async () => {
    const bus = new TicketPhaseBus();
    const r = await handleMcpToolCall({ token: "x".repeat(64), tool: "report_progress", input: {} }, bus);
    expect(r).toMatchObject({ ok: false, code: "unauthorized" });
    const r2 = await handleMcpToolCall({ tool: "report_progress", input: {} }, bus);
    expect(r2).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("refuses revoked tokens and unknown tools", async () => {
    const bus = new TicketPhaseBus();
    const token = registerMcpSession({ ticketId: "t1", jobId: null, worktreePath: wt });
    expect(await handleMcpToolCall({ token, tool: "rm_rf", input: {} }, bus)).toMatchObject({ code: "unknown_tool" });
    revokeMcpSession(token);
    expect(await handleMcpToolCall({ token, tool: "get_ticket_context", input: {} }, bus)).toMatchObject({
      code: "unauthorized",
    });
  });

  it("binds the call to the token's ticket and emits on the bus", async () => {
    const bus = new TicketPhaseBus();
    const seen: unknown[] = [];
    bus.onEvent("progress", (p) => seen.push(p));
    const token = registerMcpSession({ ticketId: "t9", jobId: "j9", worktreePath: wt });
    const r = await handleMcpToolCall({ token, tool: "report_progress", input: { step: "x", status: "done" }, cwd: "/elsewhere" }, bus);
    expect(r).toEqual({ ok: true, result: { ok: true } });
    expect(seen).toEqual([{ ticketId: "t9", jobId: "j9", progress: { step: "x", status: "done" } }]);
    expect((await readWorkspace(wt)).progress).toContain("**done** x");
  });

  it("returns invalid_input for bad input", async () => {
    const bus = new TicketPhaseBus();
    const token = registerMcpSession({ ticketId: "t1", jobId: null, worktreePath: wt });
    expect(await handleMcpToolCall({ token, tool: "record_decision", input: { title: "" } }, bus)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("falls back to the reported cwd when the worktree is unknown", async () => {
    const bus = new TicketPhaseBus();
    const token = registerMcpSession({ ticketId: "t1", jobId: null, worktreePath: null });
    const r = await handleMcpToolCall({ token, tool: "submit_plan", input: { steps: ["a"], markdown: "P" }, cwd: wt }, bus);
    expect(r.ok).toBe(true);
    expect((await readWorkspace(wt)).plan).toBe("P\n");
  });
});

describe("submit_review (pull request reviews)", () => {
  const review = {
    verdict: "needs_fixes",
    summary: "One bug.",
    findings: [{ severity: "high", confidence: "high", title: "Null deref", path: "src/a.ts", line: 4, scenario: "Call a() with no user." }],
  };

  it("handleToolCall validates, persists review.json and emits review_submitted", async () => {
    const out = await handleToolCall({ ...ctx(), toolset: "pr_review" }, "submit_review", review, { emit });
    expect(out).toEqual({ ok: true });
    const saved = JSON.parse(fs.readFileSync(path.join(wt, ".flaio/ticket/review.json"), "utf-8"));
    expect(saved.findings[0]).toMatchObject({ title: "Null deref", suggestedFix: null });
    expect(events).toEqual([
      {
        event: "review_submitted",
        payload: {
          ticketId: "t1",
          jobId: "j1",
          review: { ...review, findings: [{ ...review.findings[0], suggestedFix: null }], checkedClean: [] },
        },
      },
    ]);
  });

  it("is not callable outside a pr_review toolset, and PR sessions cannot call ticket tools", async () => {
    await expect(handleToolCall(ctx(), "submit_review", review, { emit })).rejects.toThrow(/not available/);
    await expect(handleToolCall({ ...ctx(), toolset: "pr_review" }, "submit_plan", { steps: ["a"], markdown: "P" }, { emit })).rejects.toThrow(
      /not available/,
    );
    expect(events).toEqual([]);

    const bus = new TicketPhaseBus();
    const ticketToken = registerMcpSession({ ticketId: "t1", jobId: "j1", worktreePath: wt });
    expect(await handleMcpToolCall({ token: ticketToken, tool: "submit_review", input: review }, bus)).toMatchObject({
      ok: false,
      code: "unknown_tool",
    });
    const prToken = registerMcpSession({ ticketId: "rev1", jobId: "j2", worktreePath: wt, toolset: "pr_review" });
    expect(await handleMcpToolCall({ token: prToken, tool: "ask_question", input: { text: "?" } }, bus)).toMatchObject({
      ok: false,
      code: "unknown_tool",
    });
  });

  it("the CLI endpoint accepts one review per session; an invalid one can be corrected", async () => {
    const bus = new TicketPhaseBus();
    const seen: unknown[] = [];
    bus.onEvent("review_submitted", (p) => seen.push(p));
    const token = registerMcpSession({ ticketId: "rev1", jobId: "j2", worktreePath: wt, toolset: "pr_review" });

    const bad = await handleMcpToolCall({ token, tool: "submit_review", input: { verdict: "lgtm", summary: "x" } }, bus);
    expect(bad).toMatchObject({ ok: false, code: "invalid_input" });
    expect(seen).toHaveLength(0);

    // Two concurrent submissions: only one is accepted.
    const [first, second] = await Promise.all([
      handleMcpToolCall({ token, tool: "submit_review", input: review }, bus),
      handleMcpToolCall({ token, tool: "submit_review", input: { verdict: "approve", summary: "Fine." } }, bus),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: false, code: "already_submitted" });
    const third = await handleMcpToolCall({ token, tool: "submit_review", input: review }, bus);
    expect(third).toMatchObject({ ok: false, code: "already_submitted" });
    expect(seen).toEqual([expect.objectContaining({ ticketId: "rev1", jobId: "j2" })]);
  });
});
