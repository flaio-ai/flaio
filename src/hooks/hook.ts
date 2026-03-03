#!/usr/bin/env node

/**
 * PermissionRequest hook for Claude Code.
 * Sends permission request via IPC to flaio and returns the decision.
 *
 * stdin: JSON with tool_name, tool_input, session_id, cwd
 * stdout: JSON with hookSpecificOutput decision
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

  let request: Record<string, unknown>;
  try {
    request = JSON.parse(input!);
  } catch {
    process.exit(0);
  }

  const toolName = request!.tool_name as string;
  const toolInput = request!.tool_input as Record<string, unknown>;
  const sessionId = request!.session_id as string;
  const cwd = request!.cwd as string;

  const ipcResponse = await sendToHookServer(
    {
      type: "permission_request",
      payload: { toolName, toolInput, sessionId, cwd },
    },
    300000, // 5 minutes — must outlast the Slack permission poll timeout
  );

  if (ipcResponse && ipcResponse.type === "permission_reply") {
    const allowed = ipcResponse.payload.allowed as boolean;
    const message = ipcResponse.payload.message as string | undefined;

    const output = allowed
      ? {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        }
      : {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: message ?? "Denied" },
          },
        };

    fs.writeSync(1, JSON.stringify(output));
  }

  // Exit 0 to let Claude Code handle normally (fall through if no IPC response)
  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
