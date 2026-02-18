import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { getAllDrivers } from "./agent-registry.js";

export interface DetectedAgent {
  pid: number;
  driverName: string;
  displayName: string;
  command: string;
  cwd: string | null;
}

export class AgentDetector extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _detected: DetectedAgent[] = [];
  private ignoredPids: Set<number> = new Set();

  get detected(): DetectedAgent[] {
    return this._detected;
  }

  /** Mark a PID as managed by us (so we stop reporting it) */
  ignorePid(pid: number): void {
    this.ignoredPids.add(pid);
  }

  start(intervalMs: number = 5000): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private scan(): void {
    try {
      const drivers = getAllDrivers();
      const commandNames = drivers.map((d) => d.command);

      // Use ps to find processes matching known agent commands
      let psOutput: string;
      try {
        psOutput = execSync("ps aux", {
          encoding: "utf-8",
          timeout: 5000,
        });
      } catch {
        return;
      }

      const detected: DetectedAgent[] = [];
      const lines = psOutput.split("\n");

      for (const line of lines) {
        for (const driver of drivers) {
          // Match the command in the ps output
          // e.g., "user 12345 ... claude -p ..."
          const regex = new RegExp(`\\b${driver.command}\\b`);
          if (!regex.test(line)) continue;

          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[1] ?? "0");
          if (!pid || isNaN(pid) || pid === process.pid) continue;
          if (this.ignoredPids.has(pid)) continue;

          // Try to get cwd via lsof
          const cwd = this.getCwd(pid);

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
    }
  }

  private getCwd(pid: number): string | null {
    try {
      const output = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^ncwd' | head -1`, {
        encoding: "utf-8",
        timeout: 3000,
      });
      // lsof output format: "ncwd" followed by the path on next line, or "n/path"
      const match = output.match(/^n(.+)$/m);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }
}
