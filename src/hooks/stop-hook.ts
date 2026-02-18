#!/usr/bin/env node

/**
 * Stop hook for Claude Code.
 * Notifies agent-manager via IPC that a session ended.
 *
 * stdin: JSON with cwd, session_id, exit_code
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

  const sessionId = data.session_id as string;
  const cwd = data.cwd as string;
  const exitCode = data.exit_code as number;

  // Try IPC to agent-manager
  const ipcResponse = await sendToHookServer({
    type: "stop",
    payload: { sessionId, cwd, exitCode },
  });

  if (ipcResponse) {
    process.exitCode = 0;
    return;
  }

  // Fallback: direct Slack notification (legacy path)
  try {
    // @ts-ignore — legacy JS module
    const { postStopNotification } = await import("../slack-client.js");
    await postStopNotification({ sessionId, cwd, exitCode });
  } catch {
    // Non-critical
  }

  process.exitCode = 0;
}

main();
