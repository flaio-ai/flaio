#!/usr/bin/env node

/**
 * PostToolUse hook for Claude Code.
 * Posts tool results via IPC to agent-manager, or falls back to direct Slack.
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
    process.exitCode = 0;
    return;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    process.exitCode = 0;
    return;
  }

  const toolName = data.tool_name as string;
  const toolInput = data.tool_input as Record<string, unknown>;
  const toolResult = data.tool_result;
  const sessionId = data.session_id as string;
  const cwd = data.cwd as string;

  // Try IPC first
  const ipcResponse = await sendToHookServer({
    type: "post_tool_use",
    payload: { toolName, toolInput, toolResult, sessionId, cwd },
  });

  if (ipcResponse) {
    process.exitCode = 0;
    return;
  }

  // Fallback: check for marker file (only post if tool was approved via Slack)
  const markerDir = "/tmp/agent-manager-markers";
  try {
    const files = fs.readdirSync(markerDir);
    const marker = files.find((f) => f.startsWith(`${sessionId}-`));
    if (!marker) {
      process.exitCode = 0;
      return;
    }

    // Consume marker
    fs.unlinkSync(`${markerDir}/${marker}`);

    // Post result via Slack
    // @ts-ignore — legacy JS module
    const { postToolResult } = await import("../slack-client.js");
    await postToolResult({ toolName, toolInput, toolResult, sessionId, cwd });
  } catch {
    // Non-critical
  }

  process.exitCode = 0;
}

main();
