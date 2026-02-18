#!/usr/bin/env node
import { fork } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_DIR = resolve(tmpdir(), "claude-relay-pids");

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : "");
    }, timeoutMs);

    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : "");
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    process.stdin.resume();
  });
}

function pidFileFor(cwd) {
  const hash = createHash("md5").update(cwd).digest("hex").slice(0, 12);
  return resolve(PID_DIR, `watcher-${hash}.pid`);
}

function killOldWatcher(cwd) {
  const pidFile = pidFileFor(cwd);
  if (!existsSync(pidFile)) return;
  try {
    const oldPid = parseInt(readFileSync(pidFile, "utf-8").trim());
    process.kill(oldPid, "SIGTERM");
  } catch {}
}

function saveWatcherPid(cwd, pid) {
  try {
    mkdirSync(PID_DIR, { recursive: true });
    writeFileSync(pidFileFor(cwd), String(pid));
  } catch {}
}

async function main() {
  const raw = await readStdin();
  let cwd = process.cwd();
  let sessionId = "unknown";
  let exitCode = "unknown";

  try {
    if (raw.trim()) {
      const input = JSON.parse(raw);
      cwd = input.cwd || cwd;
      sessionId = input.session_id || sessionId;
      exitCode = input.exit_code ?? exitCode;
    }
  } catch {}

  // Kill any existing watcher for this project before spawning a new one
  killOldWatcher(cwd);

  const watcher = fork(resolve(__dirname, "stop-watcher.js"), [cwd, sessionId, String(exitCode)], {
    detached: true,
    stdio: "ignore",
  });

  saveWatcherPid(cwd, watcher.pid);
  watcher.unref();
  process.exit(0);
}

main();
