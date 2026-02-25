import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import type { AgentSession } from "../../agents/agent-session.js";

const SCROLL_LINES = 3;

// macOS Option key produces Unicode chars instead of ESC prefix (US English layout)
const MAC_OPT_INTERCEPT = new Set(["¡", "™", "£", "¢", "∞", "§", "¶", "•", "ª", "å"]);

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

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!stdin) return;

    setRawMode(true);

    const onData = (data: Buffer | string) => {
      if (!enabledRef.current) return;
      // Ink 6 sets stdin.setEncoding('utf8'), so data arrives as a string.
      // Support both for safety.
      const str = typeof data === "string" ? data : data.toString();
      const charCode = str.charCodeAt(0);
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

      // Single-character control keys
      if (str.length === 1) {
        // Skip global shortcuts — handled by useKeybindings/useInput
        if (
          charCode === 0x14 || // Ctrl+T
          charCode === 0x17 || // Ctrl+W
          charCode === 0x0e || // Ctrl+N
          charCode === 0x10 || // Ctrl+P
          charCode === 0x02 || // Ctrl+B
          charCode === 0x11 || // Ctrl+Q
          charCode === 0x13 || // Ctrl+S
          charCode === 0x07    // Ctrl+G (help)
        ) {
          return;
        }

        if (session) {
          // Scroll: Ctrl+U = 0x15 (up), Ctrl+D = 0x04 (down)
          if (charCode === 0x15) {
            session.scroll(-SCROLL_LINES);
            return;
          }
          if (charCode === 0x04) {
            session.scroll(SCROLL_LINES);
            return;
          }
        }
      }

      // Alt shortcuts — handled by useKeybindings, must intercept before PTY
      // ESC prefix form (terminal configured with Option=Esc)
      if (str.length === 2 && str.charCodeAt(0) === 0x1b) {
        const second = str.charCodeAt(1);
        if (second >= 0x31 && second <= 0x39) return; // Alt+1-9
        if (second === 0x61) return; // Alt+A (adopt)
      }
      // macOS Option key Unicode chars (US English layout)
      if (MAC_OPT_INTERCEPT.has(str)) return;

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
  }, [stdin, setRawMode]);
}
