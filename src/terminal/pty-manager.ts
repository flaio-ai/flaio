import { spawn, type IPty } from "node-pty";
import { EventEmitter } from "node:events";

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export class PtyManager extends EventEmitter {
  private pty: IPty | null = null;

  get pid(): number | null {
    return this.pty?.pid ?? null;
  }

  spawn(options: PtySpawnOptions): void {
    if (this.pty) {
      throw new Error("PTY already running. Kill it first.");
    }

    const shell = options.command;
    const args = options.args ?? [];
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 40;

    // Ensure PATH includes common binary locations (Homebrew, nvm, etc.)
    const currentPath = process.env.PATH ?? "";
    const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
    const fullPath = [...extraPaths.filter(p => !currentPath.includes(p)), currentPath].join(":");

    this.pty = spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...options.env,
        CLAUDECODE: "",
        PATH: fullPath,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });

    this.pty.onData((data) => {
      this.emit("data", data);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.pty = null;
      this.emit("exit", exitCode, signal);
    });
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (!this.pty) return;
    this.pty.kill(signal);
    this.pty = null;
  }

  get isRunning(): boolean {
    return this.pty !== null;
  }
}
