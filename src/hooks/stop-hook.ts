#!/usr/bin/env node

/**
 * Stop hook for Claude Code.
 * Notifies flaio via IPC that a session ended.
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
    process.exit(0);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input!);
  } catch {
    process.exit(0);
  }

  const sessionId = data!.session_id as string;
  const cwd = data!.cwd as string;
  const exitCode = data!.exit_code as number;

  await sendToHookServer({
    type: "stop",
    payload: { sessionId, cwd, exitCode },
  });

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
