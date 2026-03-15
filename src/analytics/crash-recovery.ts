import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as Sentry from "@sentry/node";

const HEARTBEAT_PATH = path.join(os.tmpdir(), "flaio-cli-heartbeat.json");
const HEARTBEAT_INTERVAL_MS = 30_000; // 30s

interface HeartbeatData {
  pid: number;
  startedAt: number;
  lastBeat: number;
  heapUsedMB: number;
  rssMB: number;
  sessionCount: number;
  uptimeHours: number;
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let startTime = 0;

/** Call on startup AFTER initSentry — detects previous unclean shutdown */
export function checkPreviousCrash(): void {
  try {
    if (!fs.existsSync(HEARTBEAT_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, "utf-8")) as HeartbeatData;
    // If PID is still alive, another instance is running — don't report
    try {
      process.kill(raw.pid, 0);
      return;
    } catch {
      /* PID dead — was unclean exit */
    }

    Sentry.captureMessage("CLI crashed (unclean shutdown detected on restart)", {
      level: "fatal",
      extra: {
        previousPid: raw.pid,
        uptimeHours: raw.uptimeHours,
        lastHeapUsedMB: raw.heapUsedMB,
        lastRssMB: raw.rssMB,
        lastSessionCount: raw.sessionCount,
        lastBeat: new Date(raw.lastBeat).toISOString(),
        startedAt: new Date(raw.startedAt).toISOString(),
      },
    });
    fs.unlinkSync(HEARTBEAT_PATH);
  } catch {
    // Best effort — don't block startup
    try {
      fs.unlinkSync(HEARTBEAT_PATH);
    } catch {}
  }
}

/** Start periodic heartbeat writes */
export function startHeartbeat(getSessionCount: () => number): void {
  startTime = Date.now();
  writeHeartbeat(getSessionCount);
  heartbeatTimer = setInterval(() => writeHeartbeat(getSessionCount), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

/** Call during clean shutdown to remove the heartbeat file */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    fs.unlinkSync(HEARTBEAT_PATH);
  } catch {}
}

function writeHeartbeat(getSessionCount: () => number): void {
  const mem = process.memoryUsage();
  const data: HeartbeatData = {
    pid: process.pid,
    startedAt: startTime,
    lastBeat: Date.now(),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
    sessionCount: getSessionCount(),
    uptimeHours: Math.round(((Date.now() - startTime) / 3600000) * 100) / 100,
  };
  try {
    fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify(data), "utf-8");
  } catch {}
}
