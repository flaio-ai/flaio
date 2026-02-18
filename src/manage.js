#!/usr/bin/env node
import { execSync } from "child_process";

const command = process.argv[2];

function getProcesses() {
  try {
    const raw = execSync("ps aux", { encoding: "utf-8" });
    const lines = raw.split("\n");
    const results = [];

    for (const line of lines) {
      const isWatcher = line.includes("stop-watcher.js") && !line.includes("grep");
      const isClaudeP = /claude\s+-p\b/.test(line) && !line.includes("grep");

      if (isWatcher || isClaudeP) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[1];
        const cmd = parts.slice(10).join(" ");
        results.push({
          pid,
          type: isWatcher ? "watcher" : "claude -p",
          cmd,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

function list() {
  const procs = getProcesses();
  if (procs.length === 0) {
    console.log("  No relay processes running.");
    return;
  }

  console.log(`\n  ${procs.length} relay process(es):\n`);
  for (const p of procs) {
    const label = p.type === "watcher" ? "Watcher (polling Slack)" : "Claude session";
    console.log(`  PID ${p.pid}  [${label}]`);
    console.log(`    ${p.cmd}\n`);
  }
}

function killAll() {
  const procs = getProcesses();
  if (procs.length === 0) {
    console.log("  No relay processes to stop.");
    return;
  }

  for (const p of procs) {
    try {
      process.kill(parseInt(p.pid), "SIGTERM");
      console.log(`  Killed PID ${p.pid} (${p.type})`);
    } catch (err) {
      console.log(`  Failed to kill PID ${p.pid}: ${err.message}`);
    }
  }

  console.log(`\n  Stopped ${procs.length} process(es).`);
}

function killOne(pid) {
  try {
    process.kill(parseInt(pid), "SIGTERM");
    console.log(`  Killed PID ${pid}`);
  } catch (err) {
    console.log(`  Failed to kill PID ${pid}: ${err.message}`);
  }
}

switch (command) {
  case "list": case "ls": case "ps":
    list();
    break;
  case "kill":
    const pid = process.argv[3];
    if (pid) killOne(pid);
    else console.log("  Usage: node src/manage.js kill <pid>  (or 'killall')");
    break;
  case "killall": case "stop":
    killAll();
    break;
  default:
    console.log("Usage:");
    console.log("  node src/manage.js list      - Show running relay processes");
    console.log("  node src/manage.js kill <pid> - Kill a specific process");
    console.log("  node src/manage.js killall    - Kill all relay processes");
}
