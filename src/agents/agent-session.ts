import { EventEmitter } from "node:events";
import { PtyManager } from "../terminal/pty-manager.js";
import { XtermBridge } from "../terminal/xterm-bridge.js";
import { ScreenBuffer, type ScreenContent } from "../terminal/screen-buffer.js";
import type { BaseDriver, AgentStatus } from "./drivers/base-driver.js";
import { SidebandReceiver } from "./sideband/sideband-receiver.js";
import {
  resolveFromClaudeHook,
  resolveFromGeminiHook,
  resolveFromGeminiOscTitle,
  extractOscTitle,
  type DetailedStatus,
  type ResolvedStatus,
  type HookEvent,
} from "./sideband/status-resolver.js";
import { sessionMetadataStore, type SessionMetadata } from "./session-metadata.js";

/** Map a basic AgentStatus to a DetailedStatus for PTY polling fallback. */
function statusToDetailed(status: AgentStatus): DetailedStatus {
  switch (status) {
    case "running": return { state: "running", detail: "general" };
    case "waiting_input": return { state: "waiting_input", detail: "prompt" };
    case "waiting_permission": return { state: "waiting_permission", detail: "tool_approval" };
    case "starting": return { state: "starting" };
    case "exited": return { state: "exited" };
    case "idle": return { state: "idle" };
  }
}

let nextId = 1;

export class AgentSession extends EventEmitter {
  readonly id: string;
  readonly driverName: string;
  readonly cwd: string;

  private pty: PtyManager;
  private xterm: XtermBridge;
  private screenBuffer: ScreenBuffer;
  private _status: AgentStatus = "idle";
  private _detailedStatus: DetailedStatus = { state: "idle" };
  private _currentTool: string | undefined;
  private recentOutput = "";
  private lastOutputTime = 0;
  private statusCheckTimer: ReturnType<typeof setInterval> | null = null;

  private sideband: SidebandReceiver;
  /** True once first hook event is received — hooks take priority over PTY polling. */
  private sidebandActive = false;
  /** Timestamp of the last hook event received. */
  private lastHookTime = 0;

  constructor(
    private driver: BaseDriver,
    options: { cwd: string; cols?: number; rows?: number; scrollback?: number },
  ) {
    super();
    this.id = `session-${nextId++}`;
    this.driverName = driver.name;
    this.cwd = options.cwd;

    const cols = options.cols ?? 120;
    const rows = options.rows ?? 40;

    this.pty = new PtyManager();
    this.xterm = new XtermBridge(cols, rows, options.scrollback);
    this.screenBuffer = new ScreenBuffer(30);
    this.sideband = new SidebandReceiver(this.id);

    // Wire PTY output → xterm → screen buffer + OSC parsing
    this.pty.on("data", (data) => {
      // Synchronous write — buffer is immediately up-to-date for grid extraction.
      // If sync flush isn't available (xterm internals changed), the write is still
      // queued and markDirty fires optimistically; the screen buffer's interval
      // will pick up the data on the next tick.
      this.xterm.writeSync(data);
      this.screenBuffer.markDirty();
      this.recentOutput += data;
      this.lastOutputTime = Date.now();
      // Keep only last 2000 chars for status detection
      if (this.recentOutput.length > 2000) {
        this.recentOutput = this.recentOutput.slice(-1000);
      }
      this.emit("raw_data", data);

      // Gemini OSC title parsing (priority 2)
      if (this.driverName === "gemini" && !this.sidebandActive) {
        const title = extractOscTitle(data);
        if (title) {
          const resolved = resolveFromGeminiOscTitle(title);
          if (resolved) {
            this.applyResolvedStatus(resolved);
          }
        }
      }
    });

    this.pty.on("exit", (code) => {
      this.stopStatusChecking();
      this.setStatus("exited");
      this._detailedStatus = { state: "exited" };
      this._currentTool = undefined;
      this.emit("detailed_status", this._detailedStatus, undefined);
      this.emit("exit", code);
    });

    this.screenBuffer.onChange((content) => {
      const cursor = { x: this.xterm.cursorX, y: this.xterm.cursorY };
      this.emit("content", content, cursor);
    });

    // Wire sideband hook events (priority 1)
    this.sideband.on("hook", (event: HookEvent) => {
      this.sidebandActive = true;
      this.lastHookTime = Date.now();
      const resolver = this.driverName === "gemini"
        ? resolveFromGeminiHook
        : resolveFromClaudeHook;
      const resolved = resolver(event);
      this.applyResolvedStatus(resolved);
    });

    // Wire sideband metadata events
    this.sideband.on("metadata", (metadata: SessionMetadata) => {
      sessionMetadataStore.update(this.id, metadata);
      this.emit("metadata", metadata);
    });
  }

  get status(): AgentStatus {
    return this._status;
  }

  get detailedStatus(): DetailedStatus {
    return this._detailedStatus;
  }

  get currentTool(): string | undefined {
    return this._currentTool;
  }

  get pid(): number | null {
    return this.pty.pid;
  }

  get cols(): number {
    return this.xterm.cols;
  }

  get rows(): number {
    return this.xterm.rows;
  }

  private setStatus(status: AgentStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit("status", status);
  }

  private applyResolvedStatus(resolved: ResolvedStatus): void {
    // Don't overwrite terminal states
    if (this._status === "exited") return;

    this._currentTool = resolved.toolName;
    this._detailedStatus = resolved.detailed;
    this.setStatus(resolved.agentStatus);
    this.emit("detailed_status", resolved.detailed, resolved.toolName);
  }

  async start(options?: {
    prompt?: string;
    mode?: "interactive" | "print";
    allowedTools?: string[];
    model?: string;
  }): Promise<void> {
    this.setStatus("starting");

    // Start sideband before spawning so the temp dir is ready
    await this.sideband.start();

    const config = this.driver.buildSpawnArgs({
      cwd: this.cwd,
      prompt: options?.prompt,
      mode: options?.mode,
      allowedTools: options?.allowedTools,
      model: options?.model,
    });

    this.pty.spawn({
      command: config.command,
      args: config.args,
      cwd: this.cwd,
      env: { ...config.env, ...this.sideband.getSpawnEnv() },
      cols: this.xterm.cols,
      rows: this.xterm.rows,
    });

    this.screenBuffer.start(() => this.xterm.extractGrid());
    this.startStatusChecking();
    this.setStatus("running");
  }

  async resume(sessionId: string, prompt?: string): Promise<void> {
    this.setStatus("starting");

    await this.sideband.start();

    const config = this.driver.buildResumeArgs({
      cwd: this.cwd,
      sessionId,
      prompt,
    });

    this.pty.spawn({
      command: config.command,
      args: config.args,
      cwd: this.cwd,
      env: { ...config.env, ...this.sideband.getSpawnEnv() },
      cols: this.xterm.cols,
      rows: this.xterm.rows,
    });

    this.screenBuffer.start(() => this.xterm.extractGrid());
    this.startStatusChecking();
    this.setStatus("running");
  }

  async continueSession(): Promise<void> {
    this.setStatus("starting");

    await this.sideband.start();

    const config = this.driver.buildContinueArgs({ cwd: this.cwd });

    this.pty.spawn({
      command: config.command,
      args: config.args,
      cwd: this.cwd,
      env: { ...config.env, ...this.sideband.getSpawnEnv() },
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
    if (cols === this.xterm.cols && rows === this.xterm.rows) return;
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
    this.pty.removeAllListeners();
    this.pty.kill();
    this.xterm.dispose();
    this.sideband.removeAllListeners();
    this.sideband.stop();
    sessionMetadataStore.remove(this.id);
    this.setStatus("exited");
    this.removeAllListeners();
  }

  getContent(): ScreenContent {
    return this.screenBuffer.getContent();
  }

  getPlainText(maxLines?: number): string[] {
    return this.xterm.extractPlainText(maxLines);
  }

  getCursorPos(): { x: number; y: number } {
    return { x: this.xterm.cursorX, y: this.xterm.cursorY };
  }

  /** Subscribe to raw PTY data events (for relay streaming). */
  onRawData(listener: (data: string) => void): () => void {
    this.on("raw_data", listener);
    return () => this.removeListener("raw_data", listener);
  }

  private startStatusChecking(): void {
    this.statusCheckTimer = setInterval(() => {
      if (this._status === "exited" || this._status === "idle") return;
      // When hooks are active and recent (within 10s), trust them over PTY polling
      if (this.sidebandActive && (Date.now() - this.lastHookTime) < 10_000) return;
      const idleMs = this.lastOutputTime > 0 ? Date.now() - this.lastOutputTime : 0;
      const detected = this.driver.detectStatus(this.recentOutput, idleMs);
      // Update both status AND detailedStatus to keep them in sync
      const detailed = statusToDetailed(detected);
      this.applyResolvedStatus({ agentStatus: detected, detailed });
    }, 1000);
  }

  private stopStatusChecking(): void {
    if (this.statusCheckTimer) {
      clearInterval(this.statusCheckTimer);
      this.statusCheckTimer = null;
    }
  }
}
