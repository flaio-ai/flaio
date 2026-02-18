#!/usr/bin/env node

/**
 * PermissionRequest hook for Claude Code.
 * Tries IPC to agent-manager first, falls back to direct Slack.
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
    process.exitCode = 0;
    return;
  }

  let request: Record<string, unknown>;
  try {
    request = JSON.parse(input);
  } catch {
    process.exitCode = 0;
    return;
  }

  const toolName = request.tool_name as string;
  const toolInput = request.tool_input as Record<string, unknown>;
  const sessionId = request.session_id as string;
  const cwd = request.cwd as string;

  // Try IPC to agent-manager first
  const ipcResponse = await sendToHookServer({
    type: "permission_request",
    payload: { toolName, toolInput, sessionId, cwd },
  });

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
    process.exitCode = 0;
    return;
  }

  // Fallback: try direct Slack (legacy path)
  try {
    // @ts-ignore — legacy JS modules without type declarations
    const { postPermissionRequest, pollForReply, postResult } = await import("../slack-client.js");
    // @ts-ignore
    const { config } = await import("../config.js");

    const messageTs = await postPermissionRequest({ toolName, toolInput, sessionId, cwd });
    const decision = await pollForReply(
      messageTs,
      config.hookTimeout,
      config.slack.pollInterval,
    );

    await postResult(messageTs, decision);

    const allowed = decision === "allow";
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
            decision: { behavior: "deny", message: `${decision} via Slack` },
          },
        };

    // Write marker file if allowed
    if (allowed) {
      const markerDir = "/tmp/agent-manager-markers";
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(
        `${markerDir}/${sessionId}-${Date.now()}`,
        JSON.stringify({ toolName, messageTs }),
      );
    }

    fs.writeSync(1, JSON.stringify(output));
    process.exitCode = 0;
  } catch {
    // If everything fails, exit 0 to let Claude Code handle normally
    process.exitCode = 0;
  }
}

main();
