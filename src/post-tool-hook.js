#!/usr/bin/env node
import { readdirSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { config } from "./config.js";
import { postToolResult } from "./slack-client.js";

const MARKER_DIR = resolve(tmpdir(), "claude-relay-markers");

function findAndConsumeMarker(sessionId, toolName) {
  try {
    const files = readdirSync(MARKER_DIR);
    // Find markers for this session, newest first
    const matching = files
      .filter((f) => f.startsWith(sessionId))
      .sort()
      .reverse();

    for (const file of matching) {
      const path = resolve(MARKER_DIR, file);
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (data.toolName === toolName) {
          unlinkSync(path);
          return data;
        }
      } catch {
        // stale marker, clean up
        try { unlinkSync(path); } catch {}
      }
    }
  } catch {
    // marker dir doesn't exist = no pending approvals
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  if (!config.slack.botToken || !config.slack.channelId) {
    process.exit(0);
  }

  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name || "Unknown";
  const sessionId = input.session_id || "unknown";

  // Only post if this tool was explicitly approved via Slack
  const marker = findAndConsumeMarker(sessionId, toolName);
  if (!marker) process.exit(0);

  const toolInput = input.tool_input || {};
  const toolResult = input.tool_result || {};
  const cwd = input.cwd || process.cwd();

  try {
    await postToolResult({ toolName, toolInput, toolResult, sessionId, cwd });
  } catch {}

  process.exit(0);
}

main();
