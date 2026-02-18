import { useEffect } from "react";
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

  useEffect(() => {
    if (!enabled || !activeSession || !stdin) return;

    setRawMode(true);

    const onData = (data: Buffer) => {
      const str = data.toString();
      const byte = data[0];

      // SGR mouse events: contain ESC[< somewhere in the data.
      // Multiple events can arrive concatenated in one chunk, so we check
      // with includes() rather than a full-string regex.
      // Button 64 = scroll wheel up, 65 = scroll wheel down.
      if (str.includes("\x1B[<")) {
        if (str.includes("\x1B[<64;")) {
          activeSession.scroll(-SCROLL_LINES);
        } else if (str.includes("\x1B[<65;")) {
          activeSession.scroll(SCROLL_LINES);
        }
        // Consume all mouse events entirely — don't forward to PTY
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
          byte === 0x11    // Ctrl+Q
        ) {
          return;
        }

        // Scroll: Ctrl+U = 0x15 (up), Ctrl+D = 0x04 (down)
        if (byte === 0x15) {
          activeSession.scroll(-SCROLL_LINES);
          return;
        }
        if (byte === 0x04) {
          activeSession.scroll(SCROLL_LINES);
          return;
        }
      }

      // Multi-byte escape sequences (non-mouse)
      if (str.startsWith("\x1B")) {
        // PageUp: ESC[5~ , Shift+Up: ESC[1;2A
        if (str === "\x1B[5~" || str === "\x1B[1;2A") {
          activeSession.scroll(-SCROLL_LINES);
          return;
        }
        // PageDown: ESC[6~ , Shift+Down: ESC[1;2B
        if (str === "\x1B[6~" || str === "\x1B[1;2B") {
          activeSession.scroll(SCROLL_LINES);
          return;
        }
      }

      // Any keypress scrolls back to bottom (like a real terminal)
      activeSession.scrollToBottom();
      activeSession.write(str);
    };

    stdin.on("data", onData);

    return () => {
      stdin.off("data", onData);
    };
  }, [activeSession, enabled, stdin, setRawMode]);
}
