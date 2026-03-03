import net from "node:net";
import fs from "node:fs";
import {
  PORTAL_SOCKET_PATH,
  type PortalClientMsg,
  type PortalServerMsg,
  type PortalSessionInfo,
  type PortalDriverInfo,
} from "./shared.js";
import { screenContentToAnsi } from "./ansi-renderer.js";

// ---------------------------------------------------------------------------
// List sessions
// ---------------------------------------------------------------------------

/**
 * Connect to the portal socket, request the session list, and return it.
 * Returns `null` if the socket doesn't exist (app not running).
 */
export async function listSessions(): Promise<PortalSessionInfo[] | null> {
  if (!fs.existsSync(PORTAL_SOCKET_PATH)) return null;

  return new Promise((resolve) => {
    const conn = net.createConnection(PORTAL_SOCKET_PATH);
    let buffer = "";

    const timeout = setTimeout(() => {
      conn.destroy();
      resolve(null);
    }, 5000);

    conn.on("connect", () => {
      const msg: PortalClientMsg = { type: "portal_list" };
      conn.write(JSON.stringify(msg) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: PortalServerMsg = JSON.parse(line);
          if (msg.type === "portal_sessions") {
            clearTimeout(timeout);
            conn.destroy();
            resolve(msg.sessions);
            return;
          }
        } catch {
          // Continue
        }
      }
    });

    conn.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// List drivers
// ---------------------------------------------------------------------------

export async function listDrivers(): Promise<PortalDriverInfo[] | null> {
  if (!fs.existsSync(PORTAL_SOCKET_PATH)) return null;

  return new Promise((resolve) => {
    const conn = net.createConnection(PORTAL_SOCKET_PATH);
    let buffer = "";

    const timeout = setTimeout(() => {
      conn.destroy();
      resolve(null);
    }, 5000);

    conn.on("connect", () => {
      const msg: PortalClientMsg = { type: "portal_list_drivers" };
      conn.write(JSON.stringify(msg) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: PortalServerMsg = JSON.parse(line);
          if (msg.type === "portal_drivers") {
            clearTimeout(timeout);
            conn.destroy();
            resolve(msg.drivers);
            return;
          }
        } catch {
          // Continue
        }
      }
    });

    conn.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Create a session
// ---------------------------------------------------------------------------

export async function createSession(
  driverName: string,
  cwd: string,
): Promise<string | null> {
  if (!fs.existsSync(PORTAL_SOCKET_PATH)) return null;

  return new Promise((resolve) => {
    const conn = net.createConnection(PORTAL_SOCKET_PATH);
    let buffer = "";

    const timeout = setTimeout(() => {
      conn.destroy();
      resolve(null);
    }, 5000);

    conn.on("connect", () => {
      const msg: PortalClientMsg = {
        type: "portal_create_session",
        driverName,
        cwd,
      };
      conn.write(JSON.stringify(msg) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: PortalServerMsg = JSON.parse(line);
          if (msg.type === "portal_session_created") {
            clearTimeout(timeout);
            conn.destroy();
            resolve(msg.sessionId);
            return;
          }
          if (msg.type === "portal_error") {
            clearTimeout(timeout);
            conn.destroy();
            resolve(null);
            return;
          }
        } catch {
          // Continue
        }
      }
    });

    conn.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Stream a session
// ---------------------------------------------------------------------------

/**
 * Connect to the portal socket, subscribe to a session, and stream its
 * output to stdout using ANSI escape codes. Captures raw stdin and forwards
 * keystrokes back to the session.
 *
 * This function does not return until the portal disconnects or the user
 * presses Ctrl+C.
 */
export async function streamSession(sessionId: string): Promise<void> {
  if (!fs.existsSync(PORTAL_SOCKET_PATH)) {
    process.stdout.write("flaio is not running.\n");
    process.exit(1);
  }

  return new Promise((resolve) => {
    const conn = net.createConnection(PORTAL_SOCKET_PATH);
    let buffer = "";
    let connected = false;

    // -- Terminal setup --

    const enterAltScreen = () => {
      process.stdout.write("\x1b[?1049h"); // alternate screen
      process.stdout.write("\x1b[?25l");   // hide hardware cursor (content renders its own)
      process.stdout.write("\x1b[?1000h"); // enable mouse reporting (for scroll capture)
      process.stdout.write("\x1b[?1006h"); // SGR extended mouse mode
    };

    const exitAltScreen = () => {
      process.stdout.write("\x1b[?1006l"); // disable SGR mouse
      process.stdout.write("\x1b[?1000l"); // disable mouse reporting
      process.stdout.write("\x1b[?25h");   // restore hardware cursor
      process.stdout.write("\x1b[?1049l"); // restore main screen
    };

    const cleanup = () => {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
      process.stdin.removeListener("data", onStdin);
      exitAltScreen();
    };

    const exit = (code = 0) => {
      cleanup();
      conn.destroy();
      resolve();
      process.exit(code);
    };

    // -- Stdin forwarding --

    const SCROLL_LINES = 3;

    const sendScroll = (lines: number) => {
      const msg: PortalClientMsg = { type: "portal_scroll", lines };
      conn.write(JSON.stringify(msg) + "\n");
    };

    const onStdin = (chunk: Buffer) => {
      const data = chunk.toString();
      const byte = chunk[0];

      // Ctrl+C (0x03) → graceful disconnect
      if (data === "\x03") {
        const msg: PortalClientMsg = { type: "portal_unsubscribe" };
        conn.write(JSON.stringify(msg) + "\n");
        exit(0);
        return;
      }

      // SGR mouse events — intercept scroll wheel, consume all others
      if (data.includes("\x1b[<")) {
        if (data.includes("\x1b[<64;")) {
          sendScroll(-SCROLL_LINES);
        } else if (data.includes("\x1b[<65;")) {
          sendScroll(SCROLL_LINES);
        }
        // Drop all other mouse events (clicks, drags — coordinates are local)
        return;
      }

      // Single-byte scroll shortcuts
      if (chunk.length === 1 && byte !== undefined) {
        // Ctrl+U = scroll up
        if (byte === 0x15) {
          sendScroll(-SCROLL_LINES);
          return;
        }
        // Ctrl+D = scroll down
        if (byte === 0x04) {
          sendScroll(SCROLL_LINES);
          return;
        }
      }

      // Multi-byte escape sequences — PageUp/Down, Shift+Up/Down
      if (data.startsWith("\x1b")) {
        if (data === "\x1b[5~" || data === "\x1b[1;2A") {
          sendScroll(-SCROLL_LINES);
          return;
        }
        if (data === "\x1b[6~" || data === "\x1b[1;2B") {
          sendScroll(SCROLL_LINES);
          return;
        }
      }

      // Forward everything else to the session
      const msg: PortalClientMsg = { type: "portal_input", data };
      conn.write(JSON.stringify(msg) + "\n");
    };

    // -- Connection --

    conn.on("connect", () => {
      connected = true;
      enterAltScreen();

      // Clear any residual stdin listeners (e.g. from Ink picker) to prevent
      // duplicate input forwarding
      process.stdin.removeAllListeners("data");

      // Enter raw mode so we get individual keystrokes
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on("data", onStdin);

      // Subscribe to the session
      const msg: PortalClientMsg = {
        type: "portal_subscribe",
        sessionId,
      };
      conn.write(JSON.stringify(msg) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: PortalServerMsg = JSON.parse(line);
          handleServerMessage(msg);
        } catch {
          // Skip malformed messages
        }
      }
    });

    conn.on("close", () => {
      if (connected) {
        cleanup();
        process.stdout.write("Connection lost.\n");
      }
      resolve();
    });

    conn.on("error", () => {
      if (connected) {
        cleanup();
        process.stdout.write("Connection error.\n");
      } else {
        process.stdout.write("Could not connect to flaio.\n");
      }
      resolve();
    });

    // -- Server message handling --

    function handleServerMessage(msg: PortalServerMsg): void {
      switch (msg.type) {
        case "portal_frame": {
          const ansi = screenContentToAnsi(msg.content, msg.cursor, msg.rows);
          process.stdout.write(ansi);
          break;
        }
        case "portal_status":
          // Status changes are informational — frame updates will follow
          break;
        case "portal_session_ended":
          cleanup();
          process.stdout.write(`Session "${sessionId}" ended.\n`);
          conn.destroy();
          resolve();
          break;
        case "portal_error":
          cleanup();
          process.stdout.write(`Error: ${msg.message}\n`);
          conn.destroy();
          resolve();
          break;
      }
    }

    // Handle SIGINT/SIGTERM
    process.on("SIGINT", () => exit(0));
    process.on("SIGTERM", () => exit(0));
  });
}
