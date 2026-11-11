// Comprehensive ANSI escape sequence stripper.
// Handles: CSI sequences (including private modes like ?25h),
// OSC sequences (terminal title etc.), and SGR color codes.
// eslint-disable-next-line no-control-regex
const RE_ANSI = /\x1B(?:\[[\x20-\x3F]*[\x40-\x7E]|\].*?(?:\x07|\x1B\\))/g;

export function stripAnsi(text: string): string {
  return text.replace(RE_ANSI, "");
}
