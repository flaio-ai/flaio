import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

const SOCKET_DIR = path.join(os.tmpdir(), "agent-manager");
const SOCKET_PATH = path.join(SOCKET_DIR, "hooks.sock");

export interface HookMessage {
  type: "permission_request" | "post_tool_use" | "stop" | "notification";
  payload: Record<string, unknown>;
}

export interface HookResponse {
  type: "permission_reply" | "ack";
  payload: Record<string, unknown>;
}

/**
 * Unix socket IPC server that hooks connect to.
 * Runs inside the agent-manager process.
 */
export class HookServer extends EventEmitter {
  private server: net.Server | null = null;

  get socketPath(): string {
    return SOCKET_PATH;
  }

  async start(): Promise<void> {
    // Ensure socket directory exists
    fs.mkdirSync(SOCKET_DIR, { recursive: true });

    // Remove stale socket file
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Doesn't exist — fine
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((conn) => {
        this.handleConnection(conn);
      });

      this.server.on("error", reject);
      this.server.listen(SOCKET_PATH, () => {
        // Make socket accessible
        fs.chmodSync(SOCKET_PATH, 0o600);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        try {
          fs.unlinkSync(SOCKET_PATH);
        } catch {
          // Best effort
        }
      } else {
        resolve();
      }
    });
  }

  private handleConnection(conn: net.Socket): void {
    let buffer = "";

    conn.on("data", (chunk) => {
      buffer += chunk.toString();

      // Messages are newline-delimited JSON
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: HookMessage = JSON.parse(line);
          this.handleMessage(msg, conn);
        } catch {
          conn.write(JSON.stringify({ type: "error", payload: { message: "Invalid JSON" } }) + "\n");
        }
      }
    });
  }

  private handleMessage(msg: HookMessage, conn: net.Socket): void {
    switch (msg.type) {
      case "permission_request": {
        // Emit to let the app handle this
        this.emit("permission_request", msg.payload, (response: HookResponse) => {
          conn.write(JSON.stringify(response) + "\n");
          conn.end();
        });
        break;
      }
      case "post_tool_use": {
        this.emit("post_tool_use", msg.payload);
        conn.write(JSON.stringify({ type: "ack", payload: {} }) + "\n");
        conn.end();
        break;
      }
      case "stop": {
        this.emit("stop", msg.payload);
        conn.write(JSON.stringify({ type: "ack", payload: {} }) + "\n");
        conn.end();
        break;
      }
      case "notification": {
        this.emit("notification", msg.payload);
        conn.write(JSON.stringify({ type: "ack", payload: {} }) + "\n");
        conn.end();
        break;
      }
    }
  }
}

/**
 * Client function used by hooks to send messages to the agent-manager.
 * Returns the response, or null if the server isn't running.
 */
export async function sendToHookServer(msg: HookMessage): Promise<HookResponse | null> {
  if (!fs.existsSync(SOCKET_PATH)) return null;

  return new Promise((resolve) => {
    const conn = net.createConnection(SOCKET_PATH);
    let buffer = "";
    const timeout = setTimeout(() => {
      conn.destroy();
      resolve(null);
    }, 10000);

    conn.on("connect", () => {
      conn.write(JSON.stringify(msg) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response: HookResponse = JSON.parse(line);
          clearTimeout(timeout);
          conn.destroy();
          resolve(response);
          return;
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
