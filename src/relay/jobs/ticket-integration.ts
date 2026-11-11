// ---------------------------------------------------------------------------
// Stage 2 wiring: plug WS-A2's ticket workspace and Flaio MCP spawn config
// into WS-A1's job runner seams (job-seams.ts).
//
//   wireTicketIntegrations(relayClient)  — called once at startup
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { disposeMcpSpawnConfig, getMcpSpawnConfig } from "../../mcp/spawn-config.js";
import { updateMcpSession } from "../../mcp/session-registry.js";
import {
  ensureExcluded,
  readWorkspace,
  recordAnswer,
  recordQuestion,
  writeBrief,
} from "../../workspace/ticket-workspace.js";
import type { McpSpawnConfigProvider, TicketWorkspaceWriter } from "./job-seams.js";

/**
 * Pick the question an answer belongs to: the explicit id when it exists, else
 * an open question whose id the answer mentions, else the newest open blocking
 * question, else the newest open question. null when nothing is open.
 */
export async function resolveAnswerQuestionId(
  worktreePath: string,
  text: string,
  explicit?: string | null,
): Promise<string | null> {
  const { parsedQuestions } = await readWorkspace(worktreePath);
  if (explicit && parsedQuestions.some((q) => q.questionId === explicit)) return explicit;
  const open = parsedQuestions.filter((q) => q.status === "open");
  const mentioned = open.find((q) => text.includes(q.questionId));
  if (mentioned) return mentioned.questionId;
  const blocking = open.filter((q) => q.blocking);
  return (blocking.at(-1) ?? open.at(-1))?.questionId ?? null;
}

/** Ticket workspace backed by src/workspace (A2). */
export const flaioTicketWorkspace: TicketWorkspaceWriter = {
  async writeBrief(worktreePath, markdown, phase) {
    // Also starts the phase the Stop hook checks (state.json phaseStartedAt).
    await writeBrief(worktreePath, markdown, phase);
  },
  async ensureExcluded(worktreePath) {
    await ensureExcluded(worktreePath);
  },
  async recordAnswer(worktreePath, answer) {
    const questionId = await resolveAnswerQuestionId(worktreePath, answer.text, answer.questionId);
    if (questionId && (await recordAnswer(worktreePath, questionId, answer.text))) return questionId;
    // No matching question: keep the answer in questions.md all the same.
    const safeJob = answer.jobId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
    const id = `a_${safeJob}_${randomBytes(3).toString("hex")}`;
    await recordQuestion(worktreePath, {
      questionId: id,
      text: "(Answer received without a matching open question.)",
      blocking: false,
    });
    await recordAnswer(worktreePath, id, answer.text);
    return id;
  },
};

/**
 * MCP spawn config provider backed by src/mcp (A2): registers a per-session
 * token bound to the ticket, job and the agent's directory, and writes the
 * --mcp-config / --settings files. dispose() revokes the token and removes them.
 */
export const flaioMcpSpawnConfigProvider: McpSpawnConfigProvider = (ticketId, jobId, ctx) => {
  const cfg = getMcpSpawnConfig(ticketId, jobId, { worktreePath: ctx.worktreePath });
  return {
    mcpConfigPath: cfg.mcpConfigPath,
    settingsPath: cfg.settingsPath,
    env: cfg.env,
    dispose: () => disposeMcpSpawnConfig(cfg),
    rebindJob: (newJobId) => {
      updateMcpSession(cfg.token, { jobId: newJobId });
    },
  };
};

export interface TicketIntegrationTarget {
  setTicketWorkspace(workspace: TicketWorkspaceWriter): void;
  setMcpSpawnConfigProvider(provider: McpSpawnConfigProvider): void;
}

/** Replace the job runner's stub seams with the real workspace + MCP config. */
export function wireTicketIntegrations(target: TicketIntegrationTarget): void {
  target.setTicketWorkspace(flaioTicketWorkspace);
  target.setMcpSpawnConfigProvider(flaioMcpSpawnConfigProvider);
}
