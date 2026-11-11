// ---------------------------------------------------------------------------
// OpenCode driver (cloud runner harness, also usable locally).
//
// Every OpenCode-specific name lives in OPENCODE below. Checked on 2026-11-11
// against the OpenCode v2 docs AND the real binary (`@opencode/cli` 2.2.7 in
// the cloud runner image: `--help`, `debug paths`, `debug config`,
// `debug agents`, `mcp add`, `models`, and `run --format json` with a fake
// key). VERIFIED = confirmed by running 2.2.7; UNVERIFIED = docs or inference
// only. The image pins the version these constants were written for.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSafeAgentArg,
  BaseDriver,
  type AgentStatus,
  type ModelInfo,
  type SpawnConfig,
  type TicketCapabilities,
  type TicketSpawnConfig,
  type TicketSpawnOptions,
} from "./base-driver.js";
import type { AgentPermissionMode, ModelProviderName } from "../../contracts/agent-loop.js";

export const OPENCODE = {
  /** VERIFIED: binary name. */
  command: "opencode",
  /** Version the cloud runner image pins (npm `@opencode/cli`). */
  pinnedVersion: "2.2.7",
  /** VERIFIED: `opencode run [flags] [<message...>]` is the non-interactive entry point. */
  runSubcommand: "run",
  /** VERIFIED: `--format json` emits NDJSON events (`{type, timestamp, sessionID, part|error}`). */
  formatFlag: "--format",
  formatJson: "json",
  /** VERIFIED: `--model provider/model[#variant]`; ids as printed by `opencode models`. */
  modelFlag: "--model",
  /** VERIFIED: `--agent <id>`; built-in "build" (all allowed) and "plan" (edit denied). */
  agentFlag: "--agent",
  /** VERIFIED: `--auto` auto-approves permissions that are not explicitly denied. */
  autoApproveFlag: "--auto",
  /** VERIFIED: `--session <id>` / `--continue`. */
  sessionFlag: "--session",
  continueFlag: "--continue",
  /**
   * VERIFIED: v2 commands talk to a shared background service by default;
   * `--standalone` runs a private server in this process tree, so the
   * session env (provider key, XDG_CONFIG_HOME) actually reaches it and
   * nothing is shared with other sessions.
   */
  standaloneFlag: "--standalone",
  /** VERIFIED: TUI `opencode [flags] [<directory>]` takes the first message as `--prompt`. */
  promptFlag: "--prompt",
  /** VERIFIED: config `$schema`. */
  configSchema: "https://opencode.ai/config.json",
  /**
   * VERIFIED: the global config dir follows XDG_CONFIG_HOME (`opencode debug
   * paths`), and `debug config` loads `<XDG_CONFIG_HOME>/opencode/opencode.json`.
   * We point it at a private temp dir so the per-job config (MCP server,
   * permissions) never lands in the worktree.
   */
  configHomeEnv: "XDG_CONFIG_HOME",
  configRelPath: path.join("opencode", "opencode.json"),
  /** VERIFIED: `opencode mcp add` writes `mcp.servers.<name> = { type: "local", command: [...], environment }`. */
  mcpServerType: "local",
  /** VERIFIED: `permissions: [{ action, resource, effect }]` (as in `debug agents`), last match wins. */
  permissionEffectAllow: "allow",
  permissionEffectDeny: "deny",
  /** VERIFIED: the built-in plan agent denies edits with action "edit". */
  editAction: "edit",
  /** VERIFIED (v2): `update: "disable" | "notify" | "auto"`. */
  updateDisabled: "disable",
  /**
   * Provider id (model prefix) and API key env var per provider.
   * VERIFIED: OPENROUTER_API_KEY (a fake key reaches OpenRouter and gets 401;
   * without it the model has no route), ANTHROPIC_API_KEY (enables the
   * anthropic/* models). OPENAI_API_KEY: openai/* models were listed with it
   * set, but not conclusively attributable to it (catalog caching); treat as
   * UNVERIFIED until a real OpenAI run is tested.
   */
  providers: {
    openrouter: { id: "openrouter", keyEnv: "OPENROUTER_API_KEY" },
    anthropic: { id: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
    openai: { id: "openai", keyEnv: "OPENAI_API_KEY" },
  } satisfies Record<ModelProviderName, { id: string; keyEnv: string }>,
  /**
   * Project-level config files. VERIFIED: `debug config` loads
   * `<project>/opencode.json` alongside the global one. A repository under
   * review is untrusted: a project config could redirect a provider's base
   * URL and capture the key, so headless runs refuse to start when one is present.
   */
  projectConfigFiles: ["opencode.json", "opencode.jsonc", ".opencode"],
  /**
   * VERIFIED (2.2.7, value "true"; "1" is NOT honoured): with this set,
   * `debug config` lists no project files, `debug agents` shows no
   * `.opencode/agent/*` agents, and `.opencode/plugin(s)/*.js` plugins (which
   * otherwise execute at startup, also from parent directories above a nested
   * git root) do not run.
   */
  disableProjectConfigEnv: ["OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_CONFIG_PROJECT_DISABLE"],
  /** UNVERIFIED effect (names found in the 2.2.7 binary): skip Claude Code compat files/skills and auto-update. */
  hardeningEnv: { OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_AUTOUPDATE: "true" },
  /** Config overrides a user's environment could inject; blanked for untrusted runs (VERIFIED: empty values are harmless). */
  configOverrideEnv: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLI_CONFIG_CONTENT"],
  /**
   * VERIFIED permission actions (2.2.7 `debug agents` + runs against a fake
   * OpenAI-compatible provider): rules are appended after the agent's own, last
   * match wins; a denied tool is not offered to the model and a call by name
   * fails ("No tool named ..."). Read-only posture = deny "*", then allow
   * read/grep/glob and the Flaio MCP tools (action `<server>_<tool>`, e.g.
   * `flaio_submit_review`). Reads outside the cwd are refused
   * (`external_directory`), but reads THROUGH a symlink inside the cwd are not
   * (the runner replaces escaping symlinks before the agent starts).
   */
  readOnlyAllow: ["read", "grep", "glob"],
  dangerousActions: ["shell", "edit", "webfetch", "websearch", "external_directory", "skill", "subagent", "browser", "question", "execute"],
  /** VERIFIED: `opencode run [flags] -- <message>` takes the message after "--" verbatim. */
  endOfFlags: "--",
} as const;

/** Contract permission mode → OpenCode built-in agent. */
const AGENT_FOR_MODE: Record<AgentPermissionMode, string> = {
  plan: "plan",
  acceptEdits: "build",
  default: "build",
};

export interface OpenCodeDriverOptions {
  /** Headless: `opencode run --format json` (process exits when done). Default: interactive TUI. */
  headless?: boolean;
  /** Provider whose key the session env carries; used to prefix bare model ids. */
  provider?: ModelProviderName;
  /** Directory for per-session config homes (default: os.tmpdir()). */
  tmpDir?: string;
}

interface ClaudeStyleMcpConfig {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

/** `provider/model` for OpenCode. Bare ids get the provider prefix; prefixed ids pass through. */
export function toOpenCodeModel(model: string, provider?: ModelProviderName): string {
  const m = model.trim();
  if (!provider) return m;
  const prefix = `${OPENCODE.providers[provider].id}/`;
  if (m.startsWith(prefix)) return m;
  // OpenRouter slugs contain a slash themselves (anthropic/claude-...): always prefix.
  if (provider === "openrouter" || !m.includes("/")) return prefix + m;
  return m;
}

/** Translate the Flaio MCP config (Claude `--mcp-config` format) into OpenCode `mcp.servers`. */
export function mcpServersFromClaudeConfig(json: ClaudeStyleMcpConfig): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(json.mcpServers ?? {})) {
    if (!s || typeof s.command !== "string") continue;
    servers[name] = {
      type: OPENCODE.mcpServerType,
      command: [s.command, ...(s.args ?? [])],
      environment: { ...(s.env ?? {}) },
    };
  }
  return servers;
}

/** `mcp__<server>__<tool>` (Claude-style allow-list entry) → OpenCode permission action `<server>_<tool>`. */
export function openCodeMcpAction(claudeToolName: string): string | null {
  const m = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(claudeToolName);
  return m ? `${m[1]}_${m[2]}` : null;
}

type PermissionRule = { action: string; resource: string; effect: string };

/**
 * Read-only posture for an untrusted workspace (pr_review): everything denied,
 * then read/grep/glob and exactly the allowed Flaio MCP tools; dangerous
 * actions denied again explicitly at the end (last match wins).
 */
export function readOnlyPermissions(allowedTools: readonly string[] = []): PermissionRule[] {
  const deny = OPENCODE.permissionEffectDeny;
  const allow = OPENCODE.permissionEffectAllow;
  const mcp = [...new Set(allowedTools.map(openCodeMcpAction).filter((a): a is string => !!a))];
  return [
    { action: "*", resource: "*", effect: deny },
    ...OPENCODE.readOnlyAllow.map((action) => ({ action, resource: "*", effect: allow })),
    ...mcp.map((action) => ({ action, resource: "*", effect: allow })),
    ...OPENCODE.dangerousActions.map((action) => ({ action, resource: "*", effect: deny })),
  ];
}

/** The per-session OpenCode config. Holds no provider key (the key is only in the env). */
export function buildOpenCodeConfig(opts: {
  permissionMode: AgentPermissionMode;
  mcpServers?: Record<string, unknown>;
  model?: string | null;
  /** Untrusted read-only run: the strict posture of readOnlyPermissions(allowedTools). */
  readOnlyUntrusted?: boolean;
  allowedTools?: readonly string[];
}): Record<string, unknown> {
  let permissions: PermissionRule[] = [];
  if (opts.readOnlyUntrusted) {
    permissions = readOnlyPermissions(opts.allowedTools);
  } else if (opts.permissionMode === "plan") {
    // Read-only review: no file edits. Shell stays available so the reviewer can run tests.
    permissions.push({ action: OPENCODE.editAction, resource: "*", effect: OPENCODE.permissionEffectDeny });
  }
  const config: Record<string, unknown> = {
    $schema: OPENCODE.configSchema,
    update: OPENCODE.updateDisabled,
    permissions,
  };
  if (opts.model) config.model = opts.model;
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) config.mcp = { servers: opts.mcpServers };
  return config;
}

/** Project config files present in `cwd` (see OPENCODE.projectConfigFiles). */
export function findProjectConfig(cwd: string): string[] {
  return OPENCODE.projectConfigFiles.filter((f) => fs.existsSync(path.join(cwd, f)));
}

export class OpenCodeDriver extends BaseDriver {
  readonly name = "opencode";
  readonly displayName = "OpenCode";
  readonly command = OPENCODE.command;

  override readonly ticketCapabilities: TicketCapabilities = {
    presetSessionId: false,
    // `--session <id>` exists, but the id is only learned from the JSON stream; not wired yet.
    resume: false,
    fork: false,
    permissionModes: true,
    mcpConfig: true,
    appendSystemPrompt: false,
    // Reviews only: the read-only posture below is verified against the real
    // binary; OpenCode has no edit mode confined safely enough for pr_fix.
    untrustedWorkspace: true,
    untrustedWorkspaceEdits: false,
  };

  /** The user's own OpenCode sessions keep their provider key (unless they ran `opencode auth`, OpenCode reads it from the env). */
  override readonly inheritedSecretEnv: readonly string[] = Object.values(OPENCODE.providers).map((p) => p.keyEnv);

  constructor(private readonly options: OpenCodeDriverOptions = {}) {
    super();
  }

  get headless(): boolean {
    return !!this.options.headless;
  }

  async checkInstalled(): Promise<boolean> {
    try {
      execSync(`which ${OPENCODE.command}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * No built-in list: OpenCode model ids depend on the provider and change
   * often. Configure `agents.models.opencode` in settings, or pass the job's
   * model string through (`provider/model`).
   */
  protected defaultModels(): ModelInfo[] {
    return [];
  }

  private modelArg(model?: string | null): string | null {
    return model ? assertSafeAgentArg("model", toOpenCodeModel(model, this.options.provider)) : null;
  }

  buildSpawnArgs(options: {
    cwd: string;
    prompt?: string;
    mode?: "interactive" | "print";
    allowedTools?: string[];
    model?: string;
  }): SpawnConfig {
    const args: string[] = [];
    const model = this.modelArg(options.model);
    if (options.mode === "print" || this.headless) {
      args.push(OPENCODE.runSubcommand, OPENCODE.standaloneFlag, OPENCODE.formatFlag, OPENCODE.formatJson);
      if (model) args.push(OPENCODE.modelFlag, model);
      if (options.prompt) args.push(OPENCODE.endOfFlags, options.prompt);
    } else {
      // Interactive TUI: `opencode [flags]`, first message via --prompt.
      if (model) args.push(OPENCODE.modelFlag, model);
      if (options.prompt) args.push(OPENCODE.promptFlag, options.prompt);
    }
    return { command: this.resolveCommand(), args };
  }

  buildResumeArgs(options: { cwd: string; sessionId: string; prompt?: string }): SpawnConfig {
    const args = this.headless
      ? [OPENCODE.runSubcommand, OPENCODE.standaloneFlag, OPENCODE.formatFlag, OPENCODE.formatJson, OPENCODE.sessionFlag, options.sessionId]
      : [OPENCODE.sessionFlag, options.sessionId];
    if (options.prompt && this.headless) args.push(OPENCODE.endOfFlags, options.prompt);
    return { command: this.resolveCommand(), args };
  }

  buildContinueArgs(_options: { cwd: string }): SpawnConfig {
    return { command: this.resolveCommand(), args: [OPENCODE.continueFlag] };
  }

  /**
   * Ticket / PR job run. Headless: `opencode run --standalone --format json
   * --agent <plan|build> --auto [--model p/m] "<prompt>"`. Note: 2.2.7 exits 0
   * even after an error event; success only ever comes from submit_review /
   * complete_phase through the Flaio MCP server. The Flaio MCP server and the permission
   * rules go into a per-session config under a private XDG_CONFIG_HOME (never
   * the worktree). The provider key is NOT handled here: the cloud runner adds
   * it to the session env (see src/runner/agent-env.ts).
   */
  override buildTicketSpawnArgs(options: TicketSpawnOptions): TicketSpawnConfig {
    const untrusted = !!options.untrustedWorkspace;
    if (untrusted && !options.readOnly) {
      throw new Error("Refusing to run OpenCode on untrusted code with edits enabled: only read-only reviews are supported");
    }
    if (untrusted && !(this.headless || options.print)) {
      throw new Error("Refusing to run OpenCode on untrusted code interactively: only headless reviews are supported");
    }
    // Untrusted runs disable project config outright (verified), so a repo's
    // own opencode.json / .opencode never loads; trusted headless runs refuse.
    if (this.headless && !untrusted) {
      const found = findProjectConfig(options.cwd);
      if (found.length > 0) {
        throw new Error(
          `Refusing to run OpenCode: the repository ships its own OpenCode config (${found.join(", ")}), ` +
            "which could redirect the provider and capture the API key",
        );
      }
    }

    let mcpServers: Record<string, unknown> | undefined;
    if (options.mcpConfigPath) {
      try {
        mcpServers = mcpServersFromClaudeConfig(
          JSON.parse(fs.readFileSync(options.mcpConfigPath, "utf-8")) as ClaudeStyleMcpConfig,
        );
      } catch (err) {
        throw new Error(`OpenCode: cannot read the Flaio MCP config: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
    }
    const model = this.modelArg(options.model);
    const configHome = writeConfigHome(
      buildOpenCodeConfig({
        permissionMode: options.permissionMode,
        mcpServers,
        model,
        readOnlyUntrusted: untrusted,
        allowedTools: options.allowedTools,
      }),
      this.options.tmpDir,
    );

    const prompt = options.appendSystemPrompt?.trim()
      ? `${options.appendSystemPrompt.trim()}\n\n---\n\n${options.prompt}`
      : options.prompt;
    const args: string[] = [];
    if (this.headless || options.print) {
      args.push(OPENCODE.runSubcommand, OPENCODE.standaloneFlag, OPENCODE.formatFlag, OPENCODE.formatJson);
      // Untrusted: always the plan agent, whatever the job's mode says (never
      // `build`); the config's rules then deny everything but reads + Flaio MCP.
      args.push(OPENCODE.agentFlag, untrusted ? AGENT_FOR_MODE.plan : AGENT_FOR_MODE[options.permissionMode]);
      // Unattended: approve what the rules do not deny (VERIFIED: denied tools stay denied with --auto).
      args.push(OPENCODE.autoApproveFlag);
      if (model) args.push(OPENCODE.modelFlag, model);
      args.push(OPENCODE.endOfFlags, prompt);
    } else {
      // Interactive TUI with its own private server (per-session config and env).
      args.push(OPENCODE.standaloneFlag, OPENCODE.agentFlag, AGENT_FOR_MODE[options.permissionMode]);
      if (model) args.push(OPENCODE.modelFlag, model);
      args.push(OPENCODE.promptFlag, prompt);
    }

    const env: Record<string, string> = { [OPENCODE.configHomeEnv]: configHome };
    if (untrusted || this.headless) {
      for (const k of OPENCODE.disableProjectConfigEnv) env[k] = "true";
    }
    if (untrusted) {
      Object.assign(env, OPENCODE.hardeningEnv);
      for (const k of OPENCODE.configOverrideEnv) env[k] = "";
    }
    return {
      command: this.resolveCommand(),
      args,
      env,
      agentSessionId: null,
      resumed: false,
    };
  }

  detectStatus(recentOutput: string, idleMs: number): AgentStatus {
    if (this.headless) {
      // NDJSON stream; the process exits when the run ends. Long model calls are silent.
      return idleMs > 120_000 ? "idle" : "running";
    }
    const raw = recentOutput.slice(-500);
    const tail = raw.slice(-80);
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail)) return "running";
    if (/>\s*$/.test(this.stripAnsi(raw))) return "waiting_input";
    return idleMs > 5000 ? "waiting_input" : "running";
  }
}

/** Write the config under a fresh private temp dir (0700/0600) and return it (the config home). */
function writeConfigHome(config: Record<string, unknown>, tmpDir?: string): string {
  const home = fs.mkdtempSync(path.join(tmpDir ?? os.tmpdir(), "flaio-opencode-"));
  fs.chmodSync(home, 0o700);
  const file = path.join(home, OPENCODE.configRelPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return home;
}
