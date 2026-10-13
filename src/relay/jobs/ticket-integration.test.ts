import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearMcpSessions, resolveMcpSession } from "../../mcp/session-registry.js";
import { readWorkspace, readWorkspaceState, recordQuestion } from "../../workspace/ticket-workspace.js";
import type { McpSpawnConfigProvider, TicketWorkspaceWriter } from "./job-seams.js";
import {
  flaioMcpSpawnConfigProvider,
  flaioTicketWorkspace,
  resolveAnswerQuestionId,
  wireTicketIntegrations,
} from "./ticket-integration.js";

let wt: string;

beforeEach(async () => {
  wt = await fsp.mkdtemp(path.join(os.tmpdir(), "flaio-integ-"));
});

afterEach(async () => {
  _clearMcpSessions();
  await fsp.rm(wt, { recursive: true, force: true });
});

describe("wireTicketIntegrations", () => {
  it("installs the A2 workspace and MCP provider", () => {
    let ws: TicketWorkspaceWriter | null = null;
    let provider: McpSpawnConfigProvider | null = null;
    wireTicketIntegrations({
      setTicketWorkspace: (w) => (ws = w),
      setMcpSpawnConfigProvider: (p) => (provider = p),
    });
    expect(ws).toBe(flaioTicketWorkspace);
    expect(provider).toBe(flaioMcpSpawnConfigProvider);
  });
});

describe("flaioMcpSpawnConfigProvider", () => {
  it("binds the token to the agent's directory and disposes it", async () => {
    const cfg = await flaioMcpSpawnConfigProvider("t1", "job1", { worktreePath: wt });
    expect(cfg?.mcpConfigPath && fs.existsSync(cfg.mcpConfigPath)).toBe(true);
    expect(cfg?.settingsPath && fs.existsSync(cfg.settingsPath)).toBe(true);
    const token = cfg?.env?.FLAIO_MCP_TOKEN as string;
    expect(cfg?.env).toMatchObject({ FLAIO_TICKET_ID: "t1", FLAIO_JOB_ID: "job1", FLAIO_TICKET_WORKTREE: wt });
    expect(resolveMcpSession(token)).toMatchObject({ ticketId: "t1", jobId: "job1", worktreePath: wt });

    cfg?.rebindJob?.("job2");
    expect(resolveMcpSession(token)?.jobId).toBe("job2");

    cfg?.dispose?.();
    expect(resolveMcpSession(token)).toBeNull();
    expect(fs.existsSync(path.dirname(cfg?.mcpConfigPath as string))).toBe(false);
    cfg?.dispose?.(); // idempotent
  });
});

describe("flaioTicketWorkspace", () => {
  it("writeBrief writes brief.md and starts a phase for the job", async () => {
    await flaioTicketWorkspace.writeBrief(wt, "# Brief", { ticketId: "t1", jobId: "job1" });
    expect(await fsp.readFile(path.join(wt, ".flaio/ticket/brief.md"), "utf-8")).toBe("# Brief\n");
    const state = await readWorkspaceState(wt);
    expect(state).toMatchObject({ ticketId: "t1", jobId: "job1" });
    expect(typeof state.phaseStartedAt).toBe("number");
  });

  it("records an answer against the newest open blocking question", async () => {
    await recordQuestion(wt, { questionId: "q_a", text: "Which DB?", blocking: true });
    await recordQuestion(wt, { questionId: "q_b", text: "Nice to have?", blocking: false });
    expect(await flaioTicketWorkspace.recordAnswer?.(wt, { text: "Postgres", jobId: "job2" })).toBe("q_a");
    const ws = await readWorkspace(wt);
    expect(ws.parsedQuestions.find((q) => q.questionId === "q_a")).toMatchObject({ status: "answered", answer: "Postgres" });
    expect(ws.openQuestions.map((q) => q.questionId)).toEqual(["q_b"]);
  });

  it("prefers an explicit or mentioned question id", async () => {
    await recordQuestion(wt, { questionId: "q_a", text: "A?", blocking: true });
    await recordQuestion(wt, { questionId: "q_b", text: "B?", blocking: false });
    expect(await resolveAnswerQuestionId(wt, "re q_b: yes")).toBe("q_b");
    expect(await resolveAnswerQuestionId(wt, "yes", "q_b")).toBe("q_b");
    expect(await resolveAnswerQuestionId(wt, "yes", "q_missing")).toBe("q_a");
  });

  it("keeps an answer with no open question in questions.md", async () => {
    const id = await flaioTicketWorkspace.recordAnswer?.(wt, { text: "Ship it", jobId: "job/3" });
    expect(id).toMatch(/^a_job_3_/);
    const ws = await readWorkspace(wt);
    expect(ws.parsedQuestions).toEqual([expect.objectContaining({ questionId: id, status: "answered", answer: "Ship it" })]);
  });
});
