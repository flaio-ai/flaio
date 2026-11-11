import { spawn, type IPty } from "node-pty";
import { EventEmitter } from "node:events";

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /**
   * Sensitive keys the child may inherit from this process's env (the user's
   * own interactive session of a driver that needs its provider key). Never set
   * for job agents on untrusted workspaces.
   */
  inheritSecretEnv?: readonly string[];
}

/** Env vars never passed to agent processes (inherited or explicit), unless allowed below. */
export const SENSITIVE_ENV_PATTERN =
  /^(AWS_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|SENTRY_AUTH_TOKEN|DATABASE_URL|DB_PASSWORD|PRIVATE_KEY|SECRET_KEY|AUTH_TOKEN|REFRESH_TOKEN|FLAIO_RUNNER_TOKEN)/i;

/**
 * Explicit allow path: an explicit `options.env` may name, in this variable
 * (comma separated), sensitive keys it deliberately passes to the agent. The
 * cloud runner uses it for the provider key it injects for one session. Only
 * keys present in that same explicit env are allowed; inherited process env
 * values are always scrubbed. The marker itself never reaches the child.
 */
export const ALLOW_SECRET_ENV_MARKER = "FLAIO_ALLOW_SECRET_ENV";

/**
 * The agent process env: scrubbed process env (except `inheritSecret` keys)
 * + explicit env (scrubbed except allowed keys).
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  explicit: Record<string, string> | undefined,
  inheritSecret: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  const inherit = new Set(inheritSecret);
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined || k === ALLOW_SECRET_ENV_MARKER) continue;
    if (SENSITIVE_ENV_PATTERN.test(k) && !inherit.has(k)) continue;
    out[k] = v;
  }
  if (!explicit) return out;
  const allowed = new Set(
    (explicit[ALLOW_SECRET_ENV_MARKER] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const [k, v] of Object.entries(explicit)) {
    if (k === ALLOW_SECRET_ENV_MARKER) continue;
    if (SENSITIVE_ENV_PATTERN.test(k) && !allowed.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export class PtyManager extends EventEmitter {
  private pty: IPty | null = null;

  get pid(): number | null {
    return this.pty?.pid ?? null;
  }

  spawn(options: PtySpawnOptions): void {
    if (this.pty) {
      throw new Error("PTY already running. Kill it first.");
    }

    const shell = options.command;
    const args = options.args ?? [];
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 40;

    // Ensure PATH includes common binary locations (Homebrew, nvm, etc.)
    const currentPath = process.env.PATH ?? "";
    const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
    const fullPath = [...extraPaths.filter(p => !currentPath.includes(p)), currentPath].join(":");

    const childEnv = buildChildEnv(process.env, options.env, options.inheritSecretEnv);

    this.pty = spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...childEnv,
        CLAUDECODE: "",
        PATH: fullPath,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });

    this.pty.onData((data) => {
      this.emit("data", data);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.pty = null;
      this.emit("exit", exitCode, signal);
    });
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (!this.pty) return;
    this.pty.kill(signal);
    this.pty = null;
  }

  get isRunning(): boolean {
    return this.pty !== null;
  }
}
