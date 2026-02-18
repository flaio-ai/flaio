#!/usr/bin/env node

/**
 * Notification hook for Claude Code.
 * Forwards assistant response notifications via IPC to agent-manager.
 *
 * stdin: JSON with message, title, session_id, cwd
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
  const message = data.message as string;
  const title = data.title as string | undefined;

  // Forward to agent-manager via IPC
  await sendToHookServer({
    type: "notification",
    payload: { sessionId, cwd, message, title },
  });

  process.exitCode = 0;
}

main();
