import { WebClient } from "@slack/web-api";
import { config } from "./config.js";

const client = new WebClient(config.slack.botToken);
const channelId = config.slack.channelId;

export async function postPermissionRequest({ toolName, toolInput, sessionId, cwd }) {
  const inputStr = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput, null, 2);
  const truncated = inputStr.length > 2500 ? inputStr.slice(0, 2500) + "\n..." : inputStr;
  const project = cwd ? cwd.split("/").filter(Boolean).pop() : "unknown";

  const text = [
    `*Claude Code needs permission*`,
    `*Project:* \`${project}\` (\`${cwd}\`)`,
    `*Session:* \`${sessionId}\``,
    `*Tool:* \`${toolName}\``,
    ``,
    "```",
    truncated,
    "```",
    ``,
    `Reply in thread: *allow* or *deny*`,
  ].join("\n");

  const result = await client.chat.postMessage({
    channel: channelId,
    text,
    unfurl_links: false,
  });

  return result.ts;
}

export async function pollForReply(messageTs, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await client.conversations.replies({
        channel: channelId,
        ts: messageTs,
        limit: 10,
      });

      if (result.messages && result.messages.length > 1) {
        for (const msg of result.messages.slice(1)) {
          if (msg.bot_id || msg.subtype === "bot_message") continue;
          const text = (msg.text || "").trim().toLowerCase();
          if (["allow", "yes", "y", "approve", "ok", "accept"].includes(text)) return "allow";
          if (["deny", "no", "n", "reject", "block"].includes(text)) return "deny";
        }
      }
    } catch (err) {
      process.stderr.write(`Slack poll error: ${err.message}\n`);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return "timeout";
}

export async function postResult(messageTs, decision) {
  const icons = { allow: "Allowed", deny: "Denied", timeout: "Timed out (denied)" };
  try {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: `*${icons[decision] || decision}*`,
      unfurl_links: false,
    });
  } catch (err) {
    process.stderr.write(`Failed to post result: ${err.message}\n`);
  }
}

export async function postStopNotification({ sessionId, cwd, exitCode }) {
  const project = cwd ? cwd.split("/").filter(Boolean).pop() : "unknown";

  const text = [
    `*Claude Code session ended*`,
    `*Project:* \`${project}\` (\`${cwd}\`)`,
    `*Session:* \`${sessionId}\``,
    `*Exit code:* \`${exitCode}\``,
    ``,
    `Reply in thread with a new prompt to continue working in this project.`,
    `Reply *skip* to ignore.`,
  ].join("\n");

  const result = await client.chat.postMessage({
    channel: channelId,
    text,
    unfurl_links: false,
  });

  return result.ts;
}

export async function pollForPromptReply(messageTs, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await client.conversations.replies({
        channel: channelId,
        ts: messageTs,
        limit: 10,
      });

      if (result.messages && result.messages.length > 1) {
        for (const msg of result.messages.slice(1)) {
          if (msg.bot_id || msg.subtype === "bot_message") continue;
          const text = (msg.text || "").trim();
          if (!text) continue;
          if (text.toLowerCase() === "skip") return null;
          return text;
        }
      }
    } catch (err) {
      process.stderr.write(`Slack poll error: ${err.message}\n`);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return null;
}

export async function postThreadUpdate(messageTs, text) {
  try {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text,
      unfurl_links: false,
    });
  } catch (err) {
    process.stderr.write(`Failed to post thread update: ${err.message}\n`);
  }
}

export async function postToolResult({ toolName, toolInput, toolResult, sessionId, cwd }) {
  const project = cwd ? cwd.split("/").filter(Boolean).pop() : "unknown";

  let resultStr = "";
  if (typeof toolResult === "string") {
    resultStr = toolResult;
  } else if (toolResult.stdout || toolResult.stderr || toolResult.output || toolResult.content) {
    resultStr = toolResult.stdout || toolResult.output || toolResult.content || "";
    if (toolResult.stderr) resultStr += (resultStr ? "\n" : "") + toolResult.stderr;
  } else {
    resultStr = JSON.stringify(toolResult, null, 2);
  }

  const maxLen = 2500;
  const truncated = resultStr.length > maxLen ? "..." + resultStr.slice(-maxLen) : resultStr;

  const inputStr = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput, null, 2);
  const inputTruncated = inputStr.length > 500 ? inputStr.slice(0, 500) + "..." : inputStr;

  const text = [
    `*Tool completed:* \`${toolName}\``,
    `*Project:* \`${project}\``,
    ``,
    `*Input:*`,
    "```",
    inputTruncated,
    "```",
    `*Result:*`,
    "```",
    truncated || "(empty)",
    "```",
  ].join("\n");

  try {
    await client.chat.postMessage({
      channel: channelId,
      text,
      unfurl_links: false,
    });
  } catch (err) {
    process.stderr.write(`Failed to post tool result: ${err.message}\n`);
  }
}
