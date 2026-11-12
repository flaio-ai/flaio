import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { makeDebugLog } from "../connectors/debug.js";

const debugLog = makeDebugLog("hooks");

const SOCKET_NAME = "hooks.sock";

/** Stable per-user id for the socket dir name (uid on POSIX, else the user name). */
function userTag(): string {
  if (typeof process.getuid === "function") return String(process.getuid());
  try {
    return os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_") || "user";
  } catch {
    return "user";
  }
}

/**
 * Default socket directory: per user, so two users on one machine never share
 * (or fight over) it. `<tmpdir>/flaio-<uid>` — on macOS tmpdir is already
 * per-user; on Linux it is /tmp, hence the uid suffix.
 */
export function defaultHookSocketDir(): string {
  return path.join(os.tmpdir(), `flaio-${userTag()}`);
}

/**
 * Fallback directory when the default one is unusable (e.g. another user
 * pre-created /tmp/flaio-<uid>): under the user's own config dir. Kept short —
 * unix socket paths are limited to ~104 bytes.
 */
export function fallbackHookSocketDir(): string {
  return path.join(os.homedir(), ".config", "flaio", "run");
}

/** Default socket path of the in-process hook server (without env override). */
export function defaultHookSocketPath(): string {
  return path.join(defaultHookSocketDir(), SOCKET_NAME);
}

/** @deprecated Use getHookSocketPath() — it honours FLAIO_HOOK_SOCKET. */
export const HOOK_SOCKET_PATH = defaultHookSocketPath();

/**
 * Socket path every client (hook scripts, the Stop hook, `flaio mcp`, spawn
 * config) connects to. `FLAIO_HOOK_SOCKET` overrides the default; the running
 * HookServer exports it into the Flaio process env on start, so every child
 * (agents and their hooks) resolves the very path the server listens on.
 */
export function getHookSocketPath(): string {
  return process.env.FLAIO_HOOK_SOCKET || defaultHookSocketPath();
}

/**
 * Create (or validate) the default socket directory. It may live in the shared
 * system temp dir (Linux), so another local user could pre-create it (or a
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
  /**
   * Export the socket path as FLAIO_HOOK_SOCKET into this process's env on
   * start, so spawned agents/hooks connect to it. Default: true when no
   * explicit socketPath is given (the app's hook server).
   */
  exportEnv?: boolean;
}

/**
 * Unix socket IPC server that hooks connect to.
 * Runs inside the flaio process.
 */
export class HookServer extends EventEmitter {
  private server: net.Server | null = null;
  private path: string;
  private readonly usesDefaultDir: boolean;
  private readonly exportEnv: boolean;

  constructor(opts: HookServerOptions = {}) {
    super();
    const envPath = process.env.FLAIO_HOOK_SOCKET || undefined;
    this.path = opts.socketPath ?? envPath ?? defaultHookSocketPath();
    // Only the built-in default dir gets the ownership check + fallback; a
    // caller- or env-supplied path's directory is the caller's responsibility.
    this.usesDefaultDir = opts.socketPath === undefined && envPath === undefined;
    this.exportEnv = opts.exportEnv ?? opts.socketPath === undefined;
  }

  get socketPath(): string {
    return this.path;
  }

  async start(): Promise<void> {
    // Ensure socket directory exists (owner-only). A caller-supplied path's
    // directory is the caller's responsibility (it may be e.g. /tmp itself).
    if (this.usesDefaultDir) {
      try {
        ensurePrivateSocketDir(path.dirname(this.path));
      } catch (err) {
        // Default dir unusable (e.g. owned by another user): use a dir under
        // our own config dir instead of failing startup. Clients find it via
        // FLAIO_HOOK_SOCKET, exported below.
        const fallback = fallbackHookSocketDir();
        ensurePrivateSocketDir(fallback);
        this.path = path.join(fallback, SOCKET_NAME);
        debugLog(`hooks: ${err instanceof Error ? err.message : String(err)} Using ${this.path} instead.`);
      }
    } else {
      fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    }
    if (this.exportEnv) process.env.FLAIO_HOOK_SOCKET = this.path;

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
