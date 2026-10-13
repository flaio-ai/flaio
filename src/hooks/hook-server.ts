import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

const SOCKET_DIR = path.join(os.tmpdir(), "flaio");
const SOCKET_PATH = path.join(SOCKET_DIR, "hooks.sock");

/** Default socket path of the in-process hook server. */
export const HOOK_SOCKET_PATH = SOCKET_PATH;

/**
 * Socket path clients should connect to. `FLAIO_HOOK_SOCKET` (set by
 * getMcpSpawnConfig for the `flaio mcp` process) overrides the default.
 */
export function getHookSocketPath(): string {
  return process.env.FLAIO_HOOK_SOCKET || SOCKET_PATH;
}

/**
 * Create (or validate) the default socket directory. It lives in the shared
 * system temp dir on Linux, so another local user could pre-create it (or a
 * symlink to their own dir); mkdir's `mode` only applies on creation. If they
 * own it they can unlink our socket and bind their own, receiving
 * FLAIO_MCP_TOKEN and tool payloads and forging permission replies. Refuse to
 * use a directory we don't own; tighten permissions on one we do.
 */
export function ensurePrivateSocketDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid()) {
    throw new Error(
      `Refusing to use hook socket directory ${dir}: it is not a directory owned by the current user. Remove it and restart Flaio.`,
    );
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

export interface HookMessage {
  /**
   * `mcp_tool_call` — a tool call forwarded by the `flaio mcp` stdio server.
   * Payload: { token, tool, input, cwd }. Authenticated by the per-session
   * token (see src/mcp/session-registry.ts); unauthenticated calls are refused.
   */
  type: "permission_request" | "post_tool_use" | "stop" | "notification" | "mcp_tool_call";
  payload: Record<string, unknown>;
}

export interface HookResponse {
  type: "permission_reply" | "ack" | "mcp_tool_result";
  payload: Record<string, unknown>;
}

export interface HookServerOptions {
  /** Override the unix socket path (tests, multiple instances). */
  socketPath?: string;
}

/**
 * Unix socket IPC server that hooks connect to.
 * Runs inside the flaio process.
 */
export class HookServer extends EventEmitter {
  private server: net.Server | null = null;
  private readonly path: string;
  private readonly usesDefaultDir: boolean;

  constructor(opts: HookServerOptions = {}) {
    super();
    this.path = opts.socketPath ?? SOCKET_PATH;
    this.usesDefaultDir = opts.socketPath === undefined;
  }

  get socketPath(): string {
    return this.path;
  }

  async start(): Promise<void> {
    // Ensure socket directory exists (owner-only). A caller-supplied path's
    // directory is the caller's responsibility (it may be e.g. /tmp itself).
    if (this.usesDefaultDir) ensurePrivateSocketDir(SOCKET_DIR);
    else fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });

    // Remove stale socket file
    try {
      fs.unlinkSync(this.path);
    } catch {
      // Doesn't exist — fine
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((conn) => {
        this.handleConnection(conn);
      });

      this.server.on("error", reject);

      // Set restrictive umask before listen so the socket is created
      // with owner-only permissions (no race window)
      const oldUmask = process.umask(0o077);
      this.server.listen(this.path, () => {
        process.umask(oldUmask);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
        try {
          fs.unlinkSync(this.path);
        } catch {
          // Best effort
        }
      } else {
        resolve();
      }
    });
  }

  private safeWrite(conn: net.Socket, data: string): void {
    if (!conn.destroyed && conn.writable) {
      conn.write(data);
    }
  }

  private handleConnection(conn: net.Socket): void {
    let buffer = "";

    conn.on("error", () => {
      conn.destroy();
    });

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
          this.safeWrite(conn, JSON.stringify({ type: "error", payload: { message: "Invalid JSON" } }) + "\n");
        }
      }
    });
  }

  private handleMessage(msg: HookMessage, conn: net.Socket): void {
    switch (msg.type) {
      case "permission_request": {
        // Emit to let the app handle this
        this.emit("permission_request", msg.payload, (response: HookResponse) => {
          this.safeWrite(conn, JSON.stringify(response) + "\n");
          conn.end();
        });
        break;
      }
      case "post_tool_use": {
        this.emit("post_tool_use", msg.payload);
        this.safeWrite(conn, JSON.stringify({ type: "ack", payload: {} }) + "\n");
        conn.end();
        break;
      }
      case "stop": {
        this.emit("stop", msg.payload);
        this.safeWrite(conn, JSON.stringify({ type: "ack", payload: {} }) + "\n");
        conn.end();
        break;
      }
      case "notification": {
        this.emit("notification", msg.payload);
        this.safeWrite(conn, JSON.stringify({ type: "ack", payload: {} }) + "\n");
        conn.end();
        break;
      }
      case "mcp_tool_call": {
        void this.handleMcpToolCall(msg.payload, conn);
        break;
      }
    }
  }

  private async handleMcpToolCall(payload: Record<string, unknown>, conn: net.Socket): Promise<void> {
    let result: Record<string, unknown>;
    try {
      // Lazy import: hook scripts import this module too and must stay light.
      const { handleMcpToolCall } = await import("../mcp/bridge.js");
      result = await handleMcpToolCall(payload);
    } catch (err) {
      result = { ok: false, code: "error", error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) this.emit("mcp_tool_call", { tool: payload.tool });
    const response: HookResponse = { type: "mcp_tool_result", payload: result };
    this.safeWrite(conn, JSON.stringify(response) + "\n");
    conn.end();
  }
}

/**
 * Client function used by hooks to send messages to flaio.
 * Returns the response, or null if the server isn't running.
 */
export async function sendToHookServer(
  msg: HookMessage,
  timeoutMs = 10000,
  socketPath: string = getHookSocketPath(),
): Promise<HookResponse | null> {
  if (!fs.existsSync(socketPath)) return null;

  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      conn.destroy();
      resolve(null);
    }, timeoutMs);

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
