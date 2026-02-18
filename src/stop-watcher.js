#!/usr/bin/env node
import { spawn, execSync } from "child_process";
import { config } from "./config.js";
import { postStopNotification, pollForPromptReply, postThreadUpdate } from "./slack-client.js";

const [cwd, sessionId, exitCode] = process.argv.slice(2);
const projectCwd = cwd || process.cwd();
const myPid = process.pid;

function killExistingClaudeSessions() {
  try {
    const raw = execSync("ps aux", { encoding: "utf-8" });
    const lines = raw.split("\n");

    for (const line of lines) {
      if (!/\bclaude\b/i.test(line)) continue;
      if (line.includes("stop-watcher") || line.includes("stop-hook") || line.includes("post-tool-hook") || line.includes("hook.js")) continue;
      if (line.includes("grep")) continue;

      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1]);
      if (pid === myPid) continue;

      // Check if this claude process is running in the same directory
      try {
        const lsofOut = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n.*cwd" || true`, { encoding: "utf-8" });
        const cwdMatch = lsofOut.trim().replace(/^n/, "");

        if (cwdMatch === projectCwd) {
          process.kill(pid, "SIGTERM");
          // Give it a moment to exit gracefully
          try { execSync(`sleep 1`); } catch {}
          // Force kill if still alive
          try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
        }
      } catch {}
    }
  } catch {}
}

function spawnClaude(args) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd: projectCwd,
      env: { ...process.env },
    });

    let output = "";

    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { output += data.toString(); });

    child.on("close", (code) => {
      resolve({ output, exitCode: code });
    });

    child.on("error", (err) => {
      resolve({ output: `Failed to start claude: ${err.message}`, exitCode: 1 });
    });
  });
}

async function runClaude(prompt) {
  const args = ["-p"];
  if (sessionId && sessionId !== "unknown") args.push("--resume", sessionId);
  args.push(prompt);
  return await spawnClaude(args);
}

async function main() {
  if (!config.slack.botToken || !config.slack.channelId) {
    process.exit(0);
  }

  try {
    const messageTs = await postStopNotification({
      sessionId: sessionId || "unknown",
      cwd: projectCwd,
      exitCode: exitCode || "unknown",
    });

    if (!messageTs) process.exit(0);

    const prompt = await pollForPromptReply(
      messageTs,
      config.stopPromptTimeout,
      config.slack.pollInterval
    );

    if (!prompt) {
      await postThreadUpdate(messageTs, "*No prompt received, staying idle.*");
      process.exit(0);
    }

    // Kill any active Claude session in this directory before resuming
    await postThreadUpdate(messageTs, `*Stopping active session, then resuming with:* \`${prompt}\``);
    killExistingClaudeSessions();

    // Small delay to ensure the old process fully releases the session
    await new Promise((r) => setTimeout(r, 2000));

    const result = await runClaude(prompt);

    const output = result.output.trim() || "(no output)";
    const maxLen = 3500;

    if (output.length <= maxLen) {
      await postThreadUpdate(messageTs, `*Claude finished (exit ${result.exitCode}):*\n\`\`\`\n${output}\n\`\`\``);
    } else {
      const truncated = "..." + output.slice(-maxLen);
      await postThreadUpdate(messageTs, `*Claude finished (exit ${result.exitCode}):*\n\`\`\`\n${truncated}\n\`\`\``);
    }

    await postThreadUpdate(messageTs, `*Session complete.* Send another prompt in the channel to continue.`);

  } catch (err) {
    process.exit(0);
  }
}

main();
