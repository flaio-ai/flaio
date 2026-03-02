// ---------------------------------------------------------------------------
// Per-session metadata store (cost, tokens, model, context window)
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";

export interface SessionMetadata {
  modelId?: string;
  modelDisplayName?: string;
  totalCostUsd?: number;
  totalDurationMs?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  contextWindow?: {
    totalTokens?: number;
    usedTokens?: number;
    usedPercentage?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  sessionId?: string;
  transcriptPath?: string;
  version?: string;
}

/**
 * Singleton metadata store — keyed by code-relay session ID.
 * Emits `"update"` with (sessionId, metadata) on every change.
 */
class SessionMetadataStore extends EventEmitter {
  private data = new Map<string, SessionMetadata>();

  get(sessionId: string): SessionMetadata | undefined {
    return this.data.get(sessionId);
  }

  update(sessionId: string, partial: Partial<SessionMetadata>): void {
    const existing = this.data.get(sessionId) ?? {};
    const merged: SessionMetadata = {
      ...existing,
      ...partial,
      contextWindow: partial.contextWindow
        ? { ...existing.contextWindow, ...partial.contextWindow }
        : existing.contextWindow,
    };
    this.data.set(sessionId, merged);
    this.emit("update", sessionId, merged);
  }

  remove(sessionId: string): void {
    this.data.delete(sessionId);
  }

  clear(): void {
    this.data.clear();
  }
}

export const sessionMetadataStore = new SessionMetadataStore();
