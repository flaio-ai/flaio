// ---------------------------------------------------------------------------
// SidebandReceiver — watches temp dir for hook events + status line metadata
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { HookEvent } from "./status-resolver.js";
import type { SessionMetadata } from "../session-metadata.js";

/**
 * SidebandReceiver manages a per-session temp directory where hook scripts
 * and status line scripts write data. It watches two files:
 *
 *   events.jsonl    — hook events (one JSON object per line, append-only)
 *   metadata.json   — status line metadata (overwritten each update)
 *
 * Emits:
 *   "hook"     (event: HookEvent)
 *   "metadata" (data: SessionMetadata)
 */
export class SidebandReceiver extends EventEmitter {
  private dir: string | null = null;
  private eventsWatcher: fs.FSWatcher | null = null;
  private metadataWatcher: fs.FSWatcher | null = null;
  private eventsOffset = 0;
  private stopped = false;
  private metadataDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sessionId: string) {
    super();
  }

  /** The sideband temp directory path (available after start). */
  get sidebandDir(): string | null {
    return this.dir;
  }

  /**
   * Env vars to inject into the PTY spawn environment.
   * Must be called after start().
   */
  getSpawnEnv(): Record<string, string> {
    if (!this.dir) return {};
    return {
      FLAIO_SESSION_ID: this.sessionId,
      FLAIO_SIDEBAND_DIR: this.dir,
      // Backward compat — remove in next major
      CODE_RELAY_SESSION_ID: this.sessionId,
      CODE_RELAY_SIDEBAND_DIR: this.dir,
    };
  }

  /** Create the temp dir and start watching. */
  async start(): Promise<void> {
    this.dir = await fsp.mkdtemp(path.join(os.tmpdir(), `flaio-${this.sessionId}-`));

    // Pre-create the files so fs.watch has something to watch
    const eventsPath = path.join(this.dir, "events.jsonl");
    const metadataPath = path.join(this.dir, "metadata.json");
    await fsp.writeFile(eventsPath, "");
    await fsp.writeFile(metadataPath, "");

    this.watchEvents(eventsPath);
    this.watchMetadata(metadataPath);
  }

  /** Stop watching and clean up the temp directory. */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.eventsWatcher) {
      this.eventsWatcher.close();
      this.eventsWatcher = null;
    }
    if (this.metadataDebounceTimer) {
      clearTimeout(this.metadataDebounceTimer);
      this.metadataDebounceTimer = null;
    }
    if (this.metadataWatcher) {
      this.metadataWatcher.close();
      this.metadataWatcher = null;
    }

    if (this.dir) {
      try {
        await fsp.rm(this.dir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
      this.dir = null;
    }
  }

  // -------------------------------------------------------------------------
  // events.jsonl watcher — read new lines on change
  // -------------------------------------------------------------------------

  private watchEvents(filePath: string): void {
    this.eventsWatcher = fs.watch(filePath, () => {
      if (this.stopped) return;
      void this.readNewEvents(filePath);
    });
  }

  private async readNewEvents(filePath: string): Promise<void> {
    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(filePath, "r");
      const stat = await fh.stat();
      const bytesToRead = stat.size - this.eventsOffset;
      if (bytesToRead <= 0) {
        await fh.close();
        return;
      }

      const buf = Buffer.alloc(bytesToRead);
      await fh.read(buf, 0, bytesToRead, this.eventsOffset);
      this.eventsOffset = stat.size;
      await fh.close();
      fh = null;

      const text = buf.toString("utf-8");
      const lines = text.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          const parsed = normalizeHookEvent(raw);
          if (parsed.hook) {
            this.emit("hook", parsed);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      if (fh !== null) {
        try { await fh.close(); } catch { /* ignore */ }
      }
    }
  }

  // -------------------------------------------------------------------------
  // metadata.json watcher — read and parse on change
  // -------------------------------------------------------------------------

  private watchMetadata(filePath: string): void {
    this.metadataWatcher = fs.watch(filePath, () => {
      if (this.stopped) return;
      if (this.metadataDebounceTimer) clearTimeout(this.metadataDebounceTimer);
      this.metadataDebounceTimer = setTimeout(() => {
        void this.readMetadata(filePath);
      }, 200);
    });
  }

  private async readMetadata(filePath: string): Promise<void> {
    try {
      const text = (await fsp.readFile(filePath, "utf-8")).trim();
      if (!text) return;
      const raw = JSON.parse(text);
      const metadata = normalizeMetadata(raw);
      this.emit("metadata", metadata);
    } catch {
      // File may be mid-write — will retry on next change
    }
  }
}

// ---------------------------------------------------------------------------
// Normalize snake_case keys from status line JSON → camelCase SessionMetadata
// ---------------------------------------------------------------------------

/**
 * Normalize a raw JSON object from events.jsonl into a HookEvent.
 * Claude Code's stdin JSON uses snake_case (tool_name, session_id),
 * while our HookEvent interface uses camelCase (toolName, sessionId).
 */
function normalizeHookEvent(raw: Record<string, unknown>): HookEvent {
  return {
    hook: raw.hook as string,
    sessionId: (raw.sessionId ?? raw.session_id) as string | undefined,
    toolName: (raw.toolName ?? raw.tool_name) as string | undefined,
    error: raw.error as string | undefined,
    notificationType: (raw.notificationType ?? raw.notification_type) as string | undefined,
    model: raw.model as string | undefined,
    raw,
  };
}

function normalizeMetadata(raw: Record<string, unknown>): SessionMetadata {
  const model = raw.model as Record<string, unknown> | undefined;
  const cost = raw.cost as Record<string, unknown> | undefined;
  const ctx = raw.context_window as Record<string, unknown> | undefined;

  const metadata: SessionMetadata = {};

  if (model) {
    if (typeof model.id === "string") metadata.modelId = model.id;
    if (typeof model.display_name === "string") metadata.modelDisplayName = model.display_name;
  }

  if (cost) {
    if (typeof cost.total_cost_usd === "number") metadata.totalCostUsd = cost.total_cost_usd;
    if (typeof cost.total_duration_ms === "number") metadata.totalDurationMs = cost.total_duration_ms;
    if (typeof cost.total_lines_added === "number") metadata.totalLinesAdded = cost.total_lines_added;
    if (typeof cost.total_lines_removed === "number") metadata.totalLinesRemoved = cost.total_lines_removed;
  }

  if (ctx) {
    metadata.contextWindow = {};
    if (typeof ctx.total_tokens === "number") metadata.contextWindow.totalTokens = ctx.total_tokens;
    if (typeof ctx.used_tokens === "number") metadata.contextWindow.usedTokens = ctx.used_tokens;
    if (typeof ctx.used_percentage === "number") metadata.contextWindow.usedPercentage = ctx.used_percentage;
    if (typeof ctx.cache_creation_tokens === "number") metadata.contextWindow.cacheCreationTokens = ctx.cache_creation_tokens;
    if (typeof ctx.cache_read_tokens === "number") metadata.contextWindow.cacheReadTokens = ctx.cache_read_tokens;
  }

  if (typeof raw.session_id === "string") metadata.sessionId = raw.session_id;
  if (typeof raw.transcript_path === "string") metadata.transcriptPath = raw.transcript_path;
  if (typeof raw.version === "string") metadata.version = raw.version;

  return metadata;
}
