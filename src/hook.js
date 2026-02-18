#!/usr/bin/env node
import { writeFileSync, mkdirSync, writeSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { config } from "./config.js";
import { postPermissionRequest, pollForReply, postResult } from "./slack-client.js";

const MARKER_DIR = resolve(tmpdir(), "claude-relay-markers");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch {
    // Can't parse input — don't block, let Claude Code handle normally
    process.exit(0);
  }

  if (!config.slack.botToken || !config.slack.channelId) {
    // Not configured — don't block
    process.exit(0);
  }

  const toolName = input.tool_name || "Unknown";
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || "unknown";
  const cwd = input.cwd || process.cwd();

  let messageTs;
  try {
    messageTs = await postPermissionRequest({ toolName, toolInput, sessionId, cwd });
  } catch {
    // Slack is down or rate-limited — don't block, let Claude Code handle normally
    process.exit(0);
  }

  if (!messageTs) {
    process.exit(0);
  }

  try {
    const decision = await pollForReply(messageTs, config.hookTimeout, config.slack.pollInterval);
    await postResult(messageTs, decision);

    if (decision === "allow") {
      try {
        mkdirSync(MARKER_DIR, { recursive: true });
        const marker = resolve(MARKER_DIR, `${sessionId}-${Date.now()}`);
        writeFileSync(marker, JSON.stringify({ toolName, sessionId, messageTs }));
      } catch {}

      writeSync(1, JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      }));
      process.exitCode = 0;
    } else {
      writeSync(1, JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: decision === "timeout" ? "Timed out waiting for Slack approval" : "Denied via Slack",
          },
        },
      }));
      process.exitCode = 2;
    }
  } catch {
    // Any error during polling — don't block, let Claude Code handle normally
    process.exit(0);
  }
}

main();
