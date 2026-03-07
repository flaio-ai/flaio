import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;

export interface Cell {
  char: string;
  fg: string | undefined;
  bg: string | undefined;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  inverse: boolean;
  strikethrough: boolean;
}

export type CellGrid = Cell[][];

// Bit masks for packed fg integer
const FG_CM_MASK = 0x3000000; // bits 24-25: color mode
const FG_CM_SHIFT = 24;
const FG_BOLD = 0x8000000; // bit 27
const FG_HAS_EXTENDED = 0x10000000; // bit 28
const FG_BLINK = 0x20000000; // bit 29
const FG_INVERSE = 0x4000000; // bit 26
const FG_STRIKETHROUGH = 0x80000000; // bit 31

// Bit masks for packed bg integer
const BG_CM_MASK = 0x3000000; // bits 24-25: color mode
const BG_CM_SHIFT = 24;
const BG_ITALIC = 0x4000000; // bit 26
const BG_DIM = 0x8000000; // bit 27
const BG_HAS_EXTENDED = 0x10000000; // bit 28

// Color modes
const CM_DEFAULT = 0;
const CM_P16 = 1;
const CM_P256 = 2;
const CM_RGB = 3;

// Standard 16 ANSI colors (normal + bright)
const ANSI_16: string[] = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00",
  "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00",
  "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];

function color256ToHex(index: number): string {
  if (index < 16) return ANSI_16[index]!;

  if (index < 232) {
    // 6x6x6 color cube (indices 16-231)
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const toVal = (c: number) => (c === 0 ? 0 : 55 + c * 40);
    return `#${toVal(r).toString(16).padStart(2, "0")}${toVal(g).toString(16).padStart(2, "0")}${toVal(b).toString(16).padStart(2, "0")}`;
  }

  // Grayscale (indices 232-255)
  const v = 8 + (index - 232) * 10;
  const h = v.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

function extractColor(packed: number, cmMask: number, cmShift: number): string | undefined {
  const mode = (packed & cmMask) >> cmShift;
  switch (mode) {
    case CM_DEFAULT:
      return undefined;
    case CM_P16: {
      const index = packed & 0xff;
      return ANSI_16[index] ?? undefined;
    }
    case CM_P256: {
      const index = packed & 0xff;
      return color256ToHex(index);
    }
    case CM_RGB: {
      const r = (packed >> 16) & 0xff;
      const g = (packed >> 8) & 0xff;
      const b = packed & 0xff;
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }
    default:
      return undefined;
  }
}

export class XtermBridge {
  private terminal: InstanceType<typeof Terminal>;
  /** Bound _innerWrite if available — used to flush the write buffer synchronously. */
  private flushWriteBuffer: (() => void) | null;

  constructor(cols: number = 120, rows: number = 40, scrollback: number = 10_000) {
    this.terminal = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback,
    });

    // Resolve once at construction — if xterm internals change, we degrade gracefully.
    const wb = (this.terminal as any)?._core?._writeBuffer;
    this.flushWriteBuffer = typeof wb?._innerWrite === "function"
      ? wb._innerWrite.bind(wb)
      : null;
  }

  write(data: string, callback?: () => void): void {
    this.terminal.write(data, callback);
  }

  /**
   * Write data and flush the write buffer synchronously if possible.
   * Returns true if the buffer was flushed (data is immediately readable),
   * false if it fell back to async (caller should use `write` with a callback).
   */
  writeSync(data: string): boolean {
    this.terminal.write(data);
    if (this.flushWriteBuffer) {
      this.flushWriteBuffer();
      return true;
    }
    return false;
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  extractGrid(): CellGrid {
    const buffer = this.terminal.buffer.active;
    const grid: CellGrid = [];

    for (let y = 0; y < this.terminal.rows; y++) {
      const line = buffer.getLine(y + buffer.viewportY);
      const row: Cell[] = [];

      if (!line) {
        grid.push([{ char: "", fg: undefined, bg: undefined, bold: false, italic: false, underline: false, dim: false, inverse: false, strikethrough: false }]);
        continue;
      }

      for (let x = 0; x < this.terminal.cols; x++) {
        const cell = line.getCell(x);
        if (!cell) {
          row.push({ char: " ", fg: undefined, bg: undefined, bold: false, italic: false, underline: false, dim: false, inverse: false, strikethrough: false });
          continue;
        }

        const fgPacked = (cell as any).fg as number;
        const bgPacked = (cell as any).bg as number;
        const ext = (cell as any).extended;
        const extVal: number = ext?._ext ?? 0;

        const fg = extractColor(fgPacked, FG_CM_MASK, FG_CM_SHIFT);
        const bg = extractColor(bgPacked, BG_CM_MASK, BG_CM_SHIFT);

        const bold = (fgPacked & FG_BOLD) !== 0;
        const inverse = (fgPacked & FG_INVERSE) !== 0;
        const strikethrough = (fgPacked & FG_STRIKETHROUGH) !== 0;

        const italic = (bgPacked & BG_ITALIC) !== 0;
        const dim = (bgPacked & BG_DIM) !== 0;

        // Underline: check if ext has a non-zero underline style (bits 26-29)
        const underlineStyle = (extVal >> 26) & 0x7;
        const underline = underlineStyle > 0;

        row.push({
          char: cell.getChars() || " ",
          fg,
          bg,
          bold,
          italic,
          underline,
          dim,
          inverse,
          strikethrough,
        });
      }

      grid.push(row);
    }

    return grid;
  }

  get cursorX(): number {
    return this.terminal.buffer.active.cursorX;
  }

  get cursorY(): number {
    return this.terminal.buffer.active.cursorY;
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  /**
   * Read plain text from the full scrollback + viewport buffer.
   * Returns an array of trimmed-end strings, one per line.
   */
  extractPlainText(maxLines?: number): string[] {
    const buffer = this.terminal.buffer.active;
    const totalLines = buffer.length;
    const start = maxLines ? Math.max(0, totalLines - maxLines) : 0;
    const lines: string[] = [];

    for (let i = start; i < totalLines; i++) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }

    return lines;
  }

  scrollLines(count: number): void {
    this.terminal.scrollLines(count);
  }

  scrollToBottom(): void {
    this.terminal.scrollToBottom();
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
