import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { getAllDrivers } from "./agent-registry.js";

export interface DetectedAgent {
  pid: number;
  driverName: string;
  displayName: string;
  command: string;
  cwd: string | null;
}

/** Run execFile and return stdout, or null on failure */
function execAsync(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Pre-compiled regex cache keyed by driver command name */
const regexCache = new Map<string, RegExp>();

function getCommandRegex(command: string): RegExp {
  let re = regexCache.get(command);
  if (!re) {
    re = new RegExp(`\\b${command}\\b`);
    regexCache.set(command, re);
  }
  return re;
}

export class AgentDetector extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _detected: DetectedAgent[] = [];
  private ignoredPids: Set<number> = new Set();
  private scanning = false;

  get detected(): DetectedAgent[] {
    return this._detected;
  }

  /** Mark a PID as managed by us (so we stop reporting it) */
  ignorePid(pid: number): void {
    this.ignoredPids.add(pid);
  }

  start(intervalMs: number = 5000): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scan(): Promise<void> {
    // Prevent overlapping scans
    if (this.scanning) return;
    this.scanning = true;

    try {
      // Prune dead ignored PIDs every scan to prevent unbounded growth
      for (const pid of this.ignoredPids) {
        try {
          process.kill(pid, 0);
        } catch {
          this.ignoredPids.delete(pid);
        }
      }

      const drivers = getAllDrivers();

      const psOutput = await execAsync("ps", ["aux"], 5000);
      if (!psOutput) {
        return;
      }

      const detected: DetectedAgent[] = [];
      const lines = psOutput.split("\n");

      for (const line of lines) {
        for (const driver of drivers) {
          const regex = getCommandRegex(driver.command);
          if (!regex.test(line)) continue;

          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[1] ?? "0");
          if (!pid || isNaN(pid) || pid === process.pid) continue;
          if (this.ignoredPids.has(pid)) continue;

          // Try to get cwd via lsof
          const cwd = await this.getCwd(pid);

          detected.push({
            pid,
            driverName: driver.name,
            displayName: driver.displayName,
            command: driver.command,
            cwd,
          });
        }
      }

      // Deduplicate by PID
      const seen = new Set<number>();
      const unique = detected.filter((a) => {
        if (seen.has(a.pid)) return false;
        seen.add(a.pid);
        return true;
      });

      const changed =
        unique.length !== this._detected.length ||
        unique.some(
          (a, i) =>
            a.pid !== this._detected[i]?.pid ||
            a.driverName !== this._detected[i]?.driverName,
        );

      if (changed) {
        this._detected = unique;
        this.emit("change", unique);
      }
    } catch {
      // Non-critical — just skip this scan
    } finally {
      this.scanning = false;
    }
  }

  private async getCwd(pid: number): Promise<string | null> {
    const output = await execAsync("lsof", ["-p", String(pid), "-Fn"], 3000);
    if (!output) return null;

    const lines = output.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "fcwd") {
        const next = lines[i + 1];
        if (next?.startsWith("n")) {
          return next.slice(1);
        }
      }
    }
    return null;
  }
}
