// ---------------------------------------------------------------------------
// `flaio mcp` — stdio MCP server (WS-A2)
//
// Spawned by the agent CLI (Claude Code `--mcp-config` or the Flaio plugin).
// Registers exactly the tools in src/contracts/mcp-tools.ts. Each call is
// forwarded to the running Flaio CLI over the local hook server, authenticated
// with FLAIO_MCP_TOKEN; the CLI persists to the ticket workspace and emits on
// the TicketPhaseBus. Without a token/CLI (manual plugin use) calls run
// standalone: they persist to the workspace only.
//
// stdout is the MCP channel — never write logs to it (use stderr).
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  FLAIO_MCP_SERVER_NAME,
  FLAIO_MCP_TOOLS,
  type FlaioMcpToolName,
} from "../contracts/mcp-tools.js";
import { sendToHookServer } from "../hooks/hook-server.js";
import { readWorkspaceState } from "../workspace/ticket-workspace.js";
import { handleToolCall, ToolInputError } from "./tool-handlers.js";

export const TOOL_DESCRIPTIONS: Record<FlaioMcpToolName, string> = {
  get_ticket_context:
    "Get the current Flaio ticket context: the brief (task, acceptance criteria, comments, answers), current plan, decisions, progress/handoff notes and open questions. Call this first when starting or resuming work on a ticket.",
  submit_plan:
    "Submit your implementation plan for review. Provide ordered steps, risks, the files you expect to touch, and the full plan as markdown. In a planning phase, call complete_phase after submitting.",
  ask_question:
    "Ask the humans a question you cannot answer from the code or the brief. blocking=true (default) parks the ticket in needs_info; after a blocking question call complete_phase with result needs_info and stop.",
  record_decision:
    "Record a notable technical decision (what you chose and why) in the ticket's decision log.",
  report_progress: "Report progress on a plan step (started, done, skipped, failed) with an optional note.",
  complete_phase:
    "Finish the current phase. This is the ONLY way to signal that the job is done. result: success | needs_info | failed, plus a summary (used as the handoff note) and the tests you ran.",
};

export type ToolCaller = (tool: FlaioMcpToolName, input: unknown) => Promise<unknown>;

export interface FlaioMcpServerOptions {
  /** Executes a validated tool call; returns the tool output object. */
  callTool: ToolCaller;
  version?: string;
}

function okResult(output: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output as Record<string, unknown>,
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Build an McpServer with the Flaio tools registered. Transport-agnostic. */
export function createFlaioMcpServer(opts: FlaioMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: FLAIO_MCP_SERVER_NAME, version: opts.version ?? "0.0.0" },
    {
      instructions:
        "Flaio ticket tools. Use get_ticket_context to load the ticket, submit_plan/ask_question/record_decision/report_progress while working, and complete_phase to finish the phase. Keep .flaio/ticket/progress.md current with a handoff note before stopping.",
    },
  );

  for (const name of Object.keys(FLAIO_MCP_TOOLS) as FlaioMcpToolName[]) {
    const { input, output } = FLAIO_MCP_TOOLS[name];
    server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: input, outputSchema: output },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          // Re-validate against the contract (applies defaults, rejects bad input).
          const parsed = (input as z.ZodType).safeParse(args ?? {});
          if (!parsed.success) {
            return errorResult(new ToolInputError(name, parsed.error.issues).message);
          }
          return okResult(await opts.callTool(name, parsed.data));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }
  return server;
}

// ---- process wiring ---------------------------------------------------------

export interface McpRuntimeConfig {
  ticketId: string | null;
  jobId: string | null;
  token: string | null;
  socketPath: string | undefined;
  worktreePath: string;
}

/** Resolve runtime config from CLI flags + environment. */
export function resolveMcpRuntimeConfig(
  flags: { ticket?: string; job?: string },
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): McpRuntimeConfig {
  const nonEmpty = (v: string | undefined) => (v && v.trim() && !v.startsWith("${") ? v.trim() : null);
  return {
    ticketId: nonEmpty(flags.ticket) ?? nonEmpty(env.FLAIO_TICKET_ID),
    jobId: nonEmpty(flags.job) ?? nonEmpty(env.FLAIO_JOB_ID),
    token: nonEmpty(env.FLAIO_MCP_TOKEN),
    socketPath: nonEmpty(env.FLAIO_HOOK_SOCKET) ?? undefined,
    worktreePath: nonEmpty(env.FLAIO_TICKET_WORKTREE) ?? nonEmpty(env.CLAUDE_PROJECT_DIR) ?? cwd,
  };
}

function log(msg: string): void {
  process.stderr.write(`[flaio mcp] ${msg}\n`);
}

/**
 * Tool caller used by the stdio process: forward to the CLI when a token is
 * present; otherwise (or if the CLI is unreachable) run standalone.
 */
export function createProcessToolCaller(cfg: McpRuntimeConfig): ToolCaller {
  const standalone: ToolCaller = async (tool, input) => {
    let ticketId = cfg.ticketId;
    if (!ticketId) ticketId = (await readWorkspaceState(cfg.worktreePath)).ticketId ?? null;
    if (!ticketId) {
      throw new Error(
        "No Flaio ticket is bound to this session. Start the agent from Flaio, pass --ticket <id>, or run /flaio:ticket <id>.",
      );
    }
    return handleToolCall({ ticketId, jobId: cfg.jobId, worktreePath: cfg.worktreePath }, tool, input);
  };

  if (!cfg.token) return standalone;

  return async (tool, input) => {
    const response = await sendToHookServer(
      { type: "mcp_tool_call", payload: { token: cfg.token, tool, input, cwd: cfg.worktreePath } },
      30000,
      cfg.socketPath,
    );
    if (!response || response.type !== "mcp_tool_result") {
      log(`Flaio CLI unreachable; handling ${tool} locally (workspace only).`);
      return standalone(tool, input);
    }
    const p = response.payload as { ok: boolean; result?: unknown; error?: string };
    if (!p.ok) throw new Error(p.error ?? "Flaio rejected the tool call");
    return p.result;
  };
}

/** Entry point for `flaio mcp`. Resolves when stdin closes. */
export async function runMcpStdioServer(flags: { ticket?: string; job?: string }, version?: string): Promise<void> {
  const cfg = resolveMcpRuntimeConfig(flags);
  const server = createFlaioMcpServer({ callTool: createProcessToolCaller(cfg), version });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.on("end", () => resolve());
  });
  await server.close().catch(() => {});
}
