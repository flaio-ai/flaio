// ---------------------------------------------------------------------------
// Flaio MCP tool handlers (WS-A2)
//
// Pure-ish core shared by both execution modes:
//   - bridged: runs inside the Flaio CLI process (via the hook server), persists
//     to the ticket workspace AND emits on the TicketPhaseBus;
//   - standalone: runs inside the MCP server process when no Flaio CLI is
//     reachable (e.g. the plugin in a manual Claude Code session) — persists
//     only.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { FLAIO_MCP_TOOLS, type FlaioMcpToolName } from "../contracts/mcp-tools.js";
import type { TicketPhaseBusEvent, TicketPhaseBusEvents } from "../contracts/ticket-phase-bus.js";
import {
  appendDecision,
  appendProgress,
  readWorkspace,
  recordQuestion,
  writePlan,
} from "../workspace/ticket-workspace.js";

export interface ToolContext {
  ticketId: string;
  jobId: string | null;
  /** Ticket worktree holding .flaio/ticket/. */
  worktreePath: string;
}

export type BusEmit = <E extends TicketPhaseBusEvent>(event: E, payload: TicketPhaseBusEvents[E]) => void;

export interface ToolDeps {
  /** Bus emitter; omit in standalone mode. */
  emit?: BusEmit;
  now?: () => number;
  newQuestionId?: () => string;
}

export type ToolOutput<N extends FlaioMcpToolName> = z.infer<(typeof FLAIO_MCP_TOOLS)[N]["output"]>;

export class ToolInputError extends Error {
  constructor(
    readonly tool: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(`Invalid input for ${tool}: ${issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    this.name = "ToolInputError";
  }
}

export function isFlaioMcpToolName(name: string): name is FlaioMcpToolName {
  return Object.prototype.hasOwnProperty.call(FLAIO_MCP_TOOLS, name);
}

export function newQuestionId(): string {
  return `q_${randomBytes(6).toString("hex")}`;
}

function parseInput<N extends FlaioMcpToolName>(name: N, raw: unknown): z.infer<(typeof FLAIO_MCP_TOOLS)[N]["input"]> {
  const schema = FLAIO_MCP_TOOLS[name].input as z.ZodType;
  const result = schema.safeParse(raw ?? {});
  if (!result.success) throw new ToolInputError(name, result.error.issues);
  return result.data as z.infer<(typeof FLAIO_MCP_TOOLS)[N]["input"]>;
}

function checkOutput<N extends FlaioMcpToolName>(name: N, out: unknown): ToolOutput<N> {
  return (FLAIO_MCP_TOOLS[name].output as z.ZodType).parse(out) as ToolOutput<N>;
}

/**
 * Validate `rawInput` with the contract schema, persist to the workspace,
 * emit the matching bus event (if `deps.emit`), and return the tool output.
 * Throws ToolInputError on invalid input.
 */
export async function handleToolCall<N extends FlaioMcpToolName>(
  ctx: ToolContext,
  name: N,
  rawInput: unknown,
  deps: ToolDeps = {},
): Promise<ToolOutput<N>> {
  const now = deps.now ?? Date.now;
  const emit: BusEmit = deps.emit ?? (() => {});
  const base = { ticketId: ctx.ticketId, jobId: ctx.jobId };

  switch (name) {
    case "get_ticket_context": {
      parseInput("get_ticket_context", rawInput);
      const ws = await readWorkspace(ctx.worktreePath);
      return checkOutput(name, {
        ticketId: ctx.ticketId,
        briefMarkdown: ws.brief ?? "",
        planMarkdown: ws.plan,
        decisionsMarkdown: ws.decisions,
        progressMarkdown: ws.progress,
        openQuestions: ws.openQuestions,
      });
    }
    case "submit_plan": {
      const plan = parseInput("submit_plan", rawInput);
      await writePlan(ctx.worktreePath, plan.markdown);
      emit("plan_submitted", { ...base, plan });
      return checkOutput(name, { ok: true });
    }
    case "ask_question": {
      const question = parseInput("ask_question", rawInput);
      const questionId = (deps.newQuestionId ?? newQuestionId)();
      await recordQuestion(ctx.worktreePath, { questionId, text: question.text, blocking: question.blocking });
      emit("question", { ...base, questionId, question });
      return checkOutput(name, { questionId });
    }
    case "record_decision": {
      const decision = parseInput("record_decision", rawInput);
      await appendDecision(ctx.worktreePath, decision, now());
      emit("decision", { ...base, decision });
      return checkOutput(name, { ok: true });
    }
    case "report_progress": {
      const progress = parseInput("report_progress", rawInput);
      await appendProgress(ctx.worktreePath, progress, now());
      emit("progress", { ...base, progress });
      return checkOutput(name, { ok: true });
    }
    case "complete_phase": {
      const completion = parseInput("complete_phase", rawInput);
      const tests = completion.testsRun.length ? `\n\nTests run:\n${completion.testsRun.map((t) => `- ${t}`).join("\n")}` : "";
      await appendProgress(
        ctx.worktreePath,
        `**Phase complete (${completion.result})**${ctx.jobId ? ` — job ${ctx.jobId}` : ""}\n\n${completion.summary}${tests}`,
        now(),
      );
      emit("phase_complete", { ...base, completion });
      return checkOutput(name, { ok: true });
    }
    default: {
      const never: never = name;
      throw new Error(`Unknown Flaio MCP tool: ${String(never)}`);
    }
  }
}
