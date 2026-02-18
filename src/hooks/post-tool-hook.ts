#!/usr/bin/env node

/**
 * PostToolUse hook for Claude Code.
 * Posts tool results via IPC to agent-manager.
 *
 * stdin: JSON with tool_name, tool_input, tool_result, session_id, cwd
 */

import fs from "node:fs";
import { sendToHookServer } from "./hook-server.js";

async function main(): Promise<void> {
  let input: string;
  try {
    input = fs.readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input!);
  } catch {
    process.exit(0);
  }

  const toolName = data!.tool_name as string;
  const toolInput = data!.tool_input as Record<string, unknown>;
  const toolResult = data!.tool_result;
  const sessionId = data!.session_id as string;
  const cwd = data!.cwd as string;

  await sendToHookServer({
    type: "post_tool_use",
    payload: { toolName, toolInput, toolResult, sessionId, cwd },
  });

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
