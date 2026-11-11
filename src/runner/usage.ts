// ---------------------------------------------------------------------------
// Token / cost usage from `opencode run --format json` (NDJSON on the PTY).
//
// Event envelope VERIFIED with opencode 2.2.7: `{"type":"step_start",
// "sessionID":..,"part":{"id":"prt_..","messageID":"msg_..",..}}`. The usage
// fields are UNVERIFIED (no real-key run yet; the docs do not list them). This parser
// is deliberately tolerant: it looks for `tokens: { input, output, cache: {
// read } }` and a numeric `cost` anywhere in an event, keyed by the part id
// (else message id) so repeated updates of one part count once.
// If nothing matches, usage stays zero and cost null; the job still finishes.
// ---------------------------------------------------------------------------

import { stripAnsi } from "../strip-ansi.js";

export interface RunnerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
}

interface Entry {
  input: number;
  output: number;
  cacheRead: number;
  cost: number | null;
}

const MAX_LINE = 1024 * 1024;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export class UsageCollector {
  private buffer = "";
  private entries = new Map<string, Entry>();
  private anon = 0;

  /** Feed raw PTY output. */
  push(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.parseLine(line);
    }
    if (this.buffer.length > MAX_LINE) this.buffer = "";
  }

  /** Parse what is left (stream ended without a newline). */
  flush(): void {
    if (this.buffer) this.parseLine(this.buffer);
    this.buffer = "";
  }

  private parseLine(raw: string): void {
    const line = stripAnsi(raw).trim();
    if (!line.startsWith("{")) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    this.visit(event, null, 0);
  }

  private visit(node: unknown, messageId: string | null, depth: number): void {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      for (const n of node) this.visit(n, messageId, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    // Part id first (each step-finish part is one step), then the message id.
    const id =
      (typeof obj.id === "string" && obj.id) ||
      (typeof obj.messageID === "string" && obj.messageID) ||
      (typeof obj.messageId === "string" && obj.messageId) ||
      messageId;
    const tokens = obj.tokens;
    if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
      const t = tokens as Record<string, unknown>;
      const cache = t.cache && typeof t.cache === "object" ? (t.cache as Record<string, unknown>) : {};
      const entry: Entry = {
        input: num(t.input) ?? 0,
        output: (num(t.output) ?? 0) + (num(t.reasoning) ?? 0),
        cacheRead: num(cache.read) ?? 0,
        cost: num(obj.cost),
      };
      if (entry.input || entry.output || entry.cacheRead || entry.cost !== null) {
        this.entries.set(id ?? `anon-${this.anon++}`, entry);
      }
      return;
    }
    for (const v of Object.values(obj)) this.visit(v, id, depth + 1);
  }

  total(): RunnerUsage {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cost: number | null = null;
    for (const e of this.entries.values()) {
      inputTokens += e.input;
      outputTokens += e.output;
      cacheReadTokens += e.cacheRead;
      if (e.cost !== null) cost = (cost ?? 0) + e.cost;
    }
    return { inputTokens, outputTokens, cacheReadTokens, costUsd: cost };
  }
}
