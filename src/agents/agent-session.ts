import { EventEmitter } from "node:events";
import { PtyManager } from "../terminal/pty-manager.js";
import { XtermBridge } from "../terminal/xterm-bridge.js";
import { ScreenBuffer, type ScreenContent } from "../terminal/screen-buffer.js";
import type { BaseDriver, AgentStatus } from "./drivers/base-driver.js";

let nextId = 1;

export class AgentSession extends EventEmitter {
  readonly id: string;
  readonly driverName: string;
  readonly cwd: string;

  private pty: PtyManager;
  private xterm: XtermBridge;
  private screenBuffer: ScreenBuffer;
  private _status: AgentStatus = "idle";
  private recentOutput = "";
  private lastOutputTime = 0;
  private statusCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private driver: BaseDriver,
    options: { cwd: string; cols?: number; rows?: number },
  ) {
    super();
    this.id = `session-${nextId++}`;
    this.driverName = driver.name;
    this.cwd = options.cwd;

    const cols = options.cols ?? 120;
    const rows = options.rows ?? 40;

    this.pty = new PtyManager();
    this.xterm = new XtermBridge(cols, rows);
    this.screenBuffer = new ScreenBuffer(30);

    // Wire PTY output → xterm → screen buffer
    this.pty.on("data", (data) => {
      this.xterm.write(data);
      this.recentOutput += data;
      this.lastOutputTime = Date.now();
      // Keep only last 2000 chars for status detection
      if (this.recentOutput.length > 2000) {
        this.recentOutput = this.recentOutput.slice(-1000);
      }
      this.screenBuffer.markDirty();
    });

    this.pty.on("exit", (code) => {
      this.stopStatusChecking();
      this.setStatus("exited");
      this.emit("exit", code);
    });

    this.screenBuffer.onChange((content) => {
      const cursor = { x: this.xterm.cursorX, y: this.xterm.cursorY };
      this.emit("content", content, cursor);
    });
  }

  get status(): AgentStatus {
    return this._status;
  }

  private setStatus(status: AgentStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit("status", status);
  }

  start(options?: { prompt?: string }): void {
    this.setStatus("starting");
    const config = this.driver.buildSpawnArgs({
      cwd: this.cwd,
      prompt: options?.prompt,
    });

    this.pty.spawn({
      command: config.command,
      args: config.args,
      cwd: this.cwd,
      env: config.env,
      cols: this.xterm.cols,
      rows: this.xterm.rows,
    });

    this.screenBuffer.start(() => this.xterm.extractGrid());
    this.startStatusChecking();
    this.setStatus("running");
  }

  resume(sessionId: string, prompt?: string): void {
    this.setStatus("starting");
    const config = this.driver.buildResumeArgs({
      cwd: this.cwd,
      sessionId,
      prompt,
    });

    this.pty.spawn({
      command: config.command,
      args: config.args,
      cwd: this.cwd,
      env: config.env,
      cols: this.xterm.cols,
      rows: this.xterm.rows,
    });

    this.screenBuffer.start(() => this.xterm.extractGrid());
    this.startStatusChecking();
    this.setStatus("running");
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
    this.xterm.resize(cols, rows);
  }

  scroll(lines: number): void {
    this.xterm.scrollLines(lines);
    this.screenBuffer.markDirty();
  }

  scrollToBottom(): void {
    this.xterm.scrollToBottom();
    this.screenBuffer.markDirty();
  }

  kill(): void {
    this.stopStatusChecking();
    this.screenBuffer.stop();
    this.pty.kill();
    this.xterm.dispose();
    this.setStatus("exited");
  }

  getContent(): ScreenContent {
    return this.screenBuffer.getContent();
  }

  getCursorPos(): { x: number; y: number } {
    return { x: this.xterm.cursorX, y: this.xterm.cursorY };
  }

  private startStatusChecking(): void {
    this.statusCheckTimer = setInterval(() => {
      if (this._status === "exited" || this._status === "idle") return;
      const idleMs = this.lastOutputTime > 0 ? Date.now() - this.lastOutputTime : 0;
      const detected = this.driver.detectStatus(this.recentOutput, idleMs);
      this.setStatus(detected);
    }, 1000);
  }

  private stopStatusChecking(): void {
    if (this.statusCheckTimer) {
      clearInterval(this.statusCheckTimer);
      this.statusCheckTimer = null;
    }
  }
}
