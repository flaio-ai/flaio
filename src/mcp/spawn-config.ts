// ---------------------------------------------------------------------------
// MCP spawn config for ticket agents (WS-A2 → used by WS-A1 on spawn)
//
// getMcpSpawnConfig() registers a per-session token and writes:
//   - mcp.json      — Claude Code `--mcp-config` file pointing at `flaio mcp`
//   - settings.json — Claude Code `--settings` file adding the ticket Stop hook
// into a private temp dir (0700/0600, the token is a secret).
// Must not import relay-client (A1 imports this module).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FLAIO_MCP_SERVER_NAME } from "../contracts/mcp-tools.js";
import { getHookSocketPath } from "../hooks/hook-server.js";
import { registerMcpSession, revokeMcpSession } from "./session-registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface McpSpawnConfig {
  /** Pass as `--mcp-config <path>` to Claude Code. */
  mcpConfigPath: string;
  /** Pass as `--settings <path>` to Claude Code to enable the ticket Stop hook. */
  settingsPath: string;
  /**
   * Env vars to add to the AGENT process env. Hooks and plugin-provided MCP
   * servers inherit them, so the Flaio plugin's `flaio` server (if the user has
   * the plugin enabled) is bridged to the same ticket session as the
   * --mcp-config one. Includes the session token.
   */
  env: Record<string, string>;
  /** Per-session token (already embedded in mcp.json's server env). */
  token: string;
  /** Temp directory holding both files. */
  dir: string;
}

export interface McpSpawnOptions {
  /** Ticket worktree path. Strongly recommended; otherwise the MCP process cwd is used. */
  worktreePath?: string;
  /** Override the hook server socket (defaults to getHookSocketPath(), i.e. the running HookServer's). */
  socketPath?: string;
  /** Override the node binary / CLI entry (tests). */
  nodePath?: string;
  cliEntry?: string;
}

/** Return a `[command, ...args]` that runs a flaio source/dist module with node. */
export function nodeInvocation(entry: string, nodePath: string = process.execPath): { command: string; args: string[] } {
  if (/\.(ts|tsx|mts)$/.test(entry)) {
    // Dev mode (running from src via tsx): load the tsx ESM loader by absolute URL
    // so it resolves regardless of the agent's cwd.
    let loader = "tsx";
    try {
      loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    } catch {
      // fall back to bare specifier
    }
    return { command: nodePath, args: ["--import", loader, entry] };
  }
  return { command: nodePath, args: [entry] };
}

function firstExisting(candidates: string[]): string {
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

/** Path of the flaio CLI entry next to this module (dist/cli.js or src/cli.tsx). */
export function resolveCliEntry(): string {
  return firstExisting([path.resolve(here, "../cli.js"), path.resolve(here, "../cli.tsx")]);
}

/** Path of the Stop hook script (dist/hooks/stop-hook.js or src/hooks/stop-hook.ts). */
export function resolveStopHookEntry(): string {
  return firstExisting([path.resolve(here, "../hooks/stop-hook.js"), path.resolve(here, "../hooks/stop-hook.ts")]);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the `--mcp-config` JSON object (Claude Code format). */
export function buildMcpConfigJson(
  ticketId: string,
  jobId: string | null,
  token: string,
  opts: McpSpawnOptions = {},
): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } {
  const { command, args } = nodeInvocation(opts.cliEntry ?? resolveCliEntry(), opts.nodePath);
  const toolArgs = ["mcp", "--ticket", ticketId, ...(jobId ? ["--job", jobId] : [])];
  const env: Record<string, string> = {
    FLAIO_MCP_TOKEN: token,
    FLAIO_HOOK_SOCKET: opts.socketPath ?? getHookSocketPath(),
    FLAIO_TICKET_ID: ticketId,
  };
  if (jobId) env.FLAIO_JOB_ID = jobId;
  if (opts.worktreePath) env.FLAIO_TICKET_WORKTREE = opts.worktreePath;
  return { mcpServers: { [FLAIO_MCP_SERVER_NAME]: { command, args: [...args, ...toolArgs], env } } };
}

/** Build the `--settings` JSON object adding the ticket Stop hook. */
export function buildStopHookSettingsJson(opts: McpSpawnOptions = {}): Record<string, unknown> {
  const { command, args } = nodeInvocation(resolveStopHookEntry(), opts.nodePath);
  return {
    hooks: {
      Stop: [
        {
          hooks: [{ type: "command", command: [command, ...args].map(shellQuote).join(" "), timeout: 30 }],
        },
      ],
    },
  };
}

/**
 * Register an MCP session for a ticket job and write the spawn files.
 *
 * WS-A1 usage when spawning Claude Code for a job:
 *   const cfg = getMcpSpawnConfig(ticket.id, job.id, { worktreePath });
 *   args.push("--mcp-config", cfg.mcpConfigPath, "--settings", cfg.settingsPath);
 *   env = { ...env, ...cfg.env };
 *   // on exit: disposeMcpSpawnConfig(cfg)
 */
export function getMcpSpawnConfig(ticketId: string, jobId: string | null, opts: McpSpawnOptions = {}): McpSpawnConfig {
  const token = registerMcpSession({ ticketId, jobId, worktreePath: opts.worktreePath ?? null });

  const safeId = ticketId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flaio-mcp-${safeId}-`));
  fs.chmodSync(dir, 0o700);

  const mcpConfigPath = path.join(dir, "mcp.json");
  fs.writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfigJson(ticketId, jobId, token, opts), null, 2) + "\n", {
    mode: 0o600,
  });

  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(buildStopHookSettingsJson(opts), null, 2) + "\n", { mode: 0o600 });

  const env: Record<string, string> = {
    FLAIO_TICKET_ID: ticketId,
    FLAIO_MCP_TOKEN: token,
    FLAIO_HOOK_SOCKET: opts.socketPath ?? getHookSocketPath(),
  };
  if (jobId) env.FLAIO_JOB_ID = jobId;
  if (opts.worktreePath) env.FLAIO_TICKET_WORKTREE = opts.worktreePath;

  return { mcpConfigPath, settingsPath, env, token, dir };
}

/** Revoke the token and delete the temp files. Safe to call twice. */
export function disposeMcpSpawnConfig(cfg: Pick<McpSpawnConfig, "token" | "dir">): void {
  revokeMcpSession(cfg.token);
  try {
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
