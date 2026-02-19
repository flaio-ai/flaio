import type { ScreenContent } from "../terminal/screen-buffer.js";

/**
 * Convert hex color "#rrggbb" to 24-bit ANSI foreground sequence.
 */
function fgFromHex(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Convert hex color "#rrggbb" to 24-bit ANSI background sequence.
 */
function bgFromHex(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Render ScreenContent (Span[][]) to a string of ANSI escape codes
 * suitable for writing directly to a terminal's stdout.
 *
 * - Cursor home at the start
 * - Each row: render spans with SGR codes, then reset + clear-to-EOL
 * - Blank remaining rows (up to `rows`) with clear-to-EOL
 * - Position cursor at the given cursor position
 */
export function screenContentToAnsi(
  content: ScreenContent,
  cursor: { x: number; y: number },
  rows: number,
): string {
  const parts: string[] = [];

  // Move cursor to top-left
  parts.push("\x1b[H");

  for (let y = 0; y < rows; y++) {
    const line = content[y];

    if (line && line.length > 0) {
      for (const span of line) {
        let sgr = "";

        // Handle inverse: swap fg/bg, default to white-on-black
        let fg = span.fg;
        let bg = span.bg;
        if (span.inverse) {
          const tmpFg = fg;
          fg = bg ?? "#000000";
          bg = tmpFg ?? "#ffffff";
        }

        if (span.bold) sgr += "\x1b[1m";
        if (span.dim) sgr += "\x1b[2m";
        if (span.italic) sgr += "\x1b[3m";
        if (span.underline) sgr += "\x1b[4m";
        if (span.strikethrough) sgr += "\x1b[9m";
        if (fg) sgr += fgFromHex(fg);
        if (bg) sgr += bgFromHex(bg);

        parts.push(sgr);
        parts.push(span.text);
        parts.push("\x1b[0m");
      }
    }

    // Clear to end of line (removes stale content from previous wider frames)
    parts.push("\x1b[K");

    // Newline for all lines except the last
    if (y < rows - 1) {
      parts.push("\r\n");
    }
  }

  // Position cursor (1-indexed)
  parts.push(`\x1b[${cursor.y + 1};${cursor.x + 1}H`);

  return parts.join("");
}
