import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import type { AgentSession } from "../../agents/agent-session.js";

const SCROLL_LINES = 3;

/**
 * Forward raw stdin bytes to the active agent's PTY.
 * Intercepts global shortcuts, scroll (mouse wheel + keyboard), and mouse events.
 * Scroll is delegated to xterm's built-in scrollback.
 */
export function useRawInput(
  activeSession: AgentSession | null,
  enabled: boolean = true,
): void {
  const { stdin, setRawMode } = useStdin();

  const sessionRef = useRef(activeSession);
  sessionRef.current = activeSession;

  useEffect(() => {
    if (!enabled || !stdin) return;

    setRawMode(true);

    const onData = (data: Buffer) => {
      const str = data.toString();
      const byte = data[0];
      const session = sessionRef.current;

      // SGR mouse events: ESC[< prefix. Only handle scroll wheel
      // (buttons 64/65), consume all others so they don't reach the PTY.
      // Hold Shift in the terminal emulator to bypass mouse mode for text selection.
      if (str.includes("\x1B[<")) {
        if (session) {
          if (str.includes("\x1B[<64;")) {
            session.scroll(-SCROLL_LINES);
          } else if (str.includes("\x1B[<65;")) {
            session.scroll(SCROLL_LINES);
          }
        }
        return;
      }

      // Single-byte control characters
      if (data.length === 1 && byte !== undefined) {
        // Skip global shortcuts — handled by useKeybindings/useInput
        if (
          byte === 0x14 || // Ctrl+T
          byte === 0x17 || // Ctrl+W
          byte === 0x0e || // Ctrl+N
          byte === 0x10 || // Ctrl+P
          byte === 0x02 || // Ctrl+B
          byte === 0x11 || // Ctrl+Q
          byte === 0x13 || // Ctrl+S
          byte === 0x07    // Ctrl+G (help)
        ) {
          return;
        }

        if (session) {
          // Scroll: Ctrl+U = 0x15 (up), Ctrl+D = 0x04 (down)
          if (byte === 0x15) {
            session.scroll(-SCROLL_LINES);
            return;
          }
          if (byte === 0x04) {
            session.scroll(SCROLL_LINES);
            return;
          }
        }
      }

      if (!session) return;

      // Multi-byte escape sequences (non-mouse)
      if (str.startsWith("\x1B")) {
        // PageUp: ESC[5~ , Shift+Up: ESC[1;2A
        if (str === "\x1B[5~" || str === "\x1B[1;2A") {
          session.scroll(-SCROLL_LINES);
          return;
        }
        // PageDown: ESC[6~ , Shift+Down: ESC[1;2B
        if (str === "\x1B[6~" || str === "\x1B[1;2B") {
          session.scroll(SCROLL_LINES);
          return;
        }
      }

      // Any keypress scrolls back to bottom (like a real terminal)
      session.scrollToBottom();
      session.write(str);
    };

    stdin.on("data", onData);

    return () => {
      stdin.off("data", onData);
    };
  }, [enabled, stdin, setRawMode]);
}
