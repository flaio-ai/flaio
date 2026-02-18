import type { Cell, CellGrid } from "./xterm-bridge.js";

export interface Span {
  text: string;
  fg: string | undefined;
  bg: string | undefined;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  inverse: boolean;
  strikethrough: boolean;
}

export type SpanLine = Span[];
export type ScreenContent = SpanLine[];

function cellsMatch(a: Cell, b: Cell): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.dim === b.dim &&
    a.inverse === b.inverse &&
    a.strikethrough === b.strikethrough
  );
}

/**
 * Convert a cell grid into merged spans per line.
 * Adjacent cells with identical styling are merged into a single span.
 */
export function gridToSpans(grid: CellGrid): ScreenContent {
  const lines: ScreenContent = [];

  for (const row of grid) {
    if (row.length === 0) {
      lines.push([]);
      continue;
    }

    const spans: SpanLine = [];
    let current: Span = {
      text: row[0]!.char,
      fg: row[0]!.fg,
      bg: row[0]!.bg,
      bold: row[0]!.bold,
      italic: row[0]!.italic,
      underline: row[0]!.underline,
      dim: row[0]!.dim,
      inverse: row[0]!.inverse,
      strikethrough: row[0]!.strikethrough,
    };

    for (let i = 1; i < row.length; i++) {
      const cell = row[i]!;
      if (cellsMatch(cell, row[i - 1]!)) {
        current.text += cell.char;
      } else {
        spans.push(current);
        current = {
          text: cell.char,
          fg: cell.fg,
          bg: cell.bg,
          bold: cell.bold,
          italic: cell.italic,
          underline: cell.underline,
          dim: cell.dim,
          inverse: cell.inverse,
          strikethrough: cell.strikethrough,
        };
      }
    }

    spans.push(current);

    // Trim trailing whitespace on the last span
    const last = spans[spans.length - 1];
    if (last && !last.fg && !last.bg && !last.bold) {
      last.text = last.text.trimEnd();
      if (last.text === "" && spans.length > 1) {
        spans.pop();
      }
    }

    lines.push(spans);
  }

  return lines;
}

/**
 * Create a debounced screen buffer that limits grid extraction to a target FPS.
 */
export class ScreenBuffer {
  private content: ScreenContent = [];
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<(content: ScreenContent) => void> = new Set();

  constructor(private targetFps: number = 30) {}

  markDirty(): void {
    this.dirty = true;
  }

  start(extractGrid: () => CellGrid): void {
    const interval = Math.floor(1000 / this.targetFps);
    this.timer = setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      const grid = extractGrid();
      this.content = gridToSpans(grid);
      for (const listener of this.listeners) {
        listener(this.content);
      }
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onChange(listener: (content: ScreenContent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getContent(): ScreenContent {
    return this.content;
  }
}
