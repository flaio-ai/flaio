// ---------------------------------------------------------------------------
// CLI-side endpoint for forwarded MCP tool calls.
//
// The HookServer (src/hooks/hook-server.ts) receives `mcp_tool_call` messages
// from the `flaio mcp` process and delegates here. We authenticate the token,
// run the tool handler (persist to the ticket workspace), and emit the matching
// event on the process-wide ticketPhaseBus for WS-A1 to forward to the relay.
// ---------------------------------------------------------------------------

import { ticketPhaseBus, type TicketPhaseBus } from "../contracts/ticket-phase-bus.js";
import { handleToolCall, isFlaioMcpToolName, ToolInputError, type BusEmit } from "./tool-handlers.js";
import { resolveMcpSession } from "./session-registry.js";

export interface McpToolCallPayload {
  token: string;
  tool: string;
  input: unknown;
  /** Working directory of the MCP server process (fallback worktree). */
  cwd?: string;
}

export type McpToolCallResult =
  | { ok: true; result: unknown }
  | { ok: false; code: "unauthorized" | "unknown_tool" | "invalid_input" | "error"; error: string };

export async function handleMcpToolCall(
  payload: Partial<McpToolCallPayload>,
  bus: TicketPhaseBus = ticketPhaseBus,
): Promise<McpToolCallResult> {
  const session = resolveMcpSession(payload.token);
  if (!session) return { ok: false, code: "unauthorized", error: "Invalid or expired Flaio MCP session token" };

  const tool = String(payload.tool ?? "");
  if (!isFlaioMcpToolName(tool)) return { ok: false, code: "unknown_tool", error: `Unknown tool: ${tool}` };

  const worktreePath = session.worktreePath ?? (typeof payload.cwd === "string" ? payload.cwd : null);
  if (!worktreePath) return { ok: false, code: "error", error: "Ticket worktree is unknown" };

  const emit: BusEmit = (event, p) => {
    bus.emitEvent(event, p);
  };

  try {
    const result = await handleToolCall(
      { ticketId: session.ticketId, jobId: session.jobId, worktreePath },
      tool,
      payload.input,
      { emit },
    );
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ToolInputError) return { ok: false, code: "invalid_input", error: err.message };
    return { ok: false, code: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
