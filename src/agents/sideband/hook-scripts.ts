// ---------------------------------------------------------------------------
// Hook script installer + settings merger for Claude Code and Gemini CLI
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HOOK_DIR = path.join(os.homedir(), ".config", "flaio", "hooks");

// ---------------------------------------------------------------------------
// Hook script content
// ---------------------------------------------------------------------------

/**
 * Shell script that appends hook JSON from stdin to the sideband events file.
 * Accepts the hook event name as $1 and injects it into the JSON.
 * No-op when FLAIO_SIDEBAND_DIR is not set (safe for normal CLI usage).
 */
const RELAY_HOOK_SH = `#!/bin/sh
# Support both new and legacy env var names
dir="\${FLAIO_SIDEBAND_DIR:-\$CODE_RELAY_SIDEBAND_DIR}"
[ -z "$dir" ] && exit 0
hook="\$1"
[ -z "$hook" ] && exit 0
input=$(cat)
[ -z "$input" ] && exit 0
# Inject the hook event name at the start of the JSON object
printf '%s\\n' "$input" | sed "s/^{/{\\"hook\\":\\"$hook\\",/" >> "$dir/events.jsonl"
`;

/**
 * Shell script for Claude Code status line. Reads JSON from stdin,
 * writes to metadata.json, then outputs a formatted display string.
 */
const RELAY_STATUSLINE_SH = `#!/bin/sh
# Support both new and legacy env var names
dir="\${FLAIO_SIDEBAND_DIR:-$CODE_RELAY_SIDEBAND_DIR}"
[ -z "$dir" ] && exit 0
input=$(cat)
printf '%s' "$input" > "$dir/metadata.json"
`;

// ---------------------------------------------------------------------------
// Install scripts to disk
// ---------------------------------------------------------------------------

export async function installHookScripts(): Promise<{ hookPath: string; statusLinePath: string }> {
  await fs.mkdir(HOOK_DIR, { recursive: true });

  const hookPath = path.join(HOOK_DIR, "relay-hook.sh");
  const statusLinePath = path.join(HOOK_DIR, "relay-statusline.sh");

  await fs.writeFile(hookPath, RELAY_HOOK_SH, { mode: 0o755 });
  await fs.writeFile(statusLinePath, RELAY_STATUSLINE_SH, { mode: 0o755 });

  return { hookPath, statusLinePath };
}

// ---------------------------------------------------------------------------
// Claude Code settings hooks config
// ---------------------------------------------------------------------------

/** All Claude Code hook event names we want to intercept. */
const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "TaskCompleted",
  "PreCompact",
  "SessionEnd",
] as const;

/**
 * Returns the hooks configuration object to merge into ~/.claude/settings.json.
 * Claude Code hook format:
 *   { "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "..." }] }] }
 * matcher is a regex string — "" or omitted matches all occurrences.
 * Some events (Stop) don't support matchers — omit matcher for those.
 */
export function getClaudeHooksConfig(hookPath: string): Record<string, unknown> {
  // Events that don't support matchers — always fire on every occurrence
  const NO_MATCHER_EVENTS = new Set(["UserPromptSubmit", "Stop", "TaskCompleted"]);

  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: "command",
          command: `${hookPath} ${event}`,
        },
      ],
    };
    if (!NO_MATCHER_EVENTS.has(event)) {
      entry.matcher = "";
    }
    hooks[event] = [entry];
  }
  return { hooks };
}

/**
 * Returns the status line configuration for ~/.claude/settings.json.
 * See: https://code.claude.com/docs/en/statusline
 */
export function getClaudeStatusLineConfig(statusLinePath: string): Record<string, unknown> {
  return {
    statusLine: {
      type: "command",
      command: statusLinePath,
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini CLI settings hooks config
// ---------------------------------------------------------------------------

const GEMINI_HOOK_EVENTS = [
  "BeforeTool",
  "AfterTool",
  "BeforeAgent",
  "AfterAgent",
  "SessionStart",
  "SessionEnd",
] as const;

/**
 * Returns hooks config to merge into ~/.gemini/settings.json.
 */
export function getGeminiHooksConfig(hookPath: string): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const event of GEMINI_HOOK_EVENTS) {
    hooks[event] = [
      {
        type: "command",
        command: hookPath,
      },
    ];
  }
  return { hooks };
}

// ---------------------------------------------------------------------------
// Settings file merger
// ---------------------------------------------------------------------------

/**
 * Reads a JSON settings file, deep-merges the patch, and writes it back.
 * For hook arrays, appends our hook if not already present (preserves user hooks).
 */
export async function mergeSettingsFile(
  filePath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(filePath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  const merged = deepMergeHooks(existing, patch);

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Deep merge that handles hooks specially: for hook arrays, removes any
 * old-format entries with the same command, then adds/replaces with new-format
 * entries. Preserves the user's OTHER hooks.
 */
function deepMergeHooks(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, sourceVal] of Object.entries(source)) {
    const targetVal = result[key];

    if (key === "hooks" && isObj(targetVal) && isObj(sourceVal)) {
      // Merge hook events individually
      const mergedHooks = { ...targetVal };
      for (const [event, hooks] of Object.entries(sourceVal)) {
        if (!Array.isArray(hooks)) continue;
        let existing = Array.isArray(mergedHooks[event]) ? [...(mergedHooks[event] as unknown[])] : [];
        for (const hook of hooks) {
          const cmd = extractCommand(hook as Record<string, unknown>);
          if (cmd) {
            // Remove any existing entries (old or new format) with the same command
            existing = existing.filter((e) => {
              if (!isObj(e)) return true;
              return extractCommand(e) !== cmd;
            });
          }
          existing.push(hook);
        }
        mergedHooks[event] = existing;
      }
      result[key] = mergedHooks;
    } else if (isObj(targetVal) && isObj(sourceVal)) {
      result[key] = deepMergeHooks(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

function isObj(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/** Extract the command string from a hook entry (supports both old and new format). */
function extractCommand(entry: Record<string, unknown>): string | null {
  // New format: { matcher: {}, hooks: [{ type, command }] }
  const entryHooks = entry.hooks;
  if (Array.isArray(entryHooks) && entryHooks.length > 0) {
    const first = entryHooks[0];
    if (isObj(first) && typeof (first as Record<string, unknown>).command === "string") {
      return (first as Record<string, unknown>).command as string;
    }
  }
  // Old format: { type, command }
  if (typeof entry.command === "string") {
    return entry.command;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Copilot CLI settings hooks config
// ---------------------------------------------------------------------------

/** Copilot CLI hook event names we want to intercept (camelCase). */
const COPILOT_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "errorOccurred",
] as const;

/**
 * Returns hooks config to merge into ~/.copilot/settings.json.
 */
export function getCopilotHooksConfig(hookPath: string): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const event of COPILOT_HOOK_EVENTS) {
    hooks[event] = [
      {
        type: "command",
        command: `${hookPath} ${event}`,
      },
    ];
  }
  return { hooks };
}

// ---------------------------------------------------------------------------
// Check if hooks are already configured
// ---------------------------------------------------------------------------

export async function areClaudeHooksConfigured(): Promise<boolean> {
  try {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    const text = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(text);
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== "object") return false;

    // Check if at least SessionStart hook exists with our script
    const sessionStartHooks = hooks.SessionStart;
    if (!Array.isArray(sessionStartHooks)) return false;

    const hookPath = path.join(HOOK_DIR, "relay-hook.sh");
    return sessionStartHooks.some((entry: unknown) => {
      if (!isObj(entry)) return false;
      // New format: { matcher: {}, hooks: [{ type, command }] }
      const entryHooks = (entry as Record<string, unknown>).hooks;
      if (Array.isArray(entryHooks)) {
        return entryHooks.some(
          (h) => isObj(h) && (h as Record<string, unknown>).command === hookPath,
        );
      }
      // Legacy format: { type, command }
      return (entry as Record<string, unknown>).command === hookPath;
    });
  } catch {
    return false;
  }
}

export async function areCopilotHooksConfigured(): Promise<boolean> {
  try {
    const settingsPath = path.join(os.homedir(), ".copilot", "settings.json");
    const text = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(text);
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== "object") return false;

    const sessionStartHooks = hooks.sessionStart;
    if (!Array.isArray(sessionStartHooks)) return false;

    const hookPath = path.join(HOOK_DIR, "relay-hook.sh");
    return sessionStartHooks.some(
      (h: unknown) => isObj(h) && (h as Record<string, unknown>).command === `${hookPath} sessionStart`,
    );
  } catch {
    return false;
  }
}

export async function areGeminiHooksConfigured(): Promise<boolean> {
  try {
    const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
    const text = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(text);
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== "object") return false;

    const sessionStartHooks = hooks.SessionStart;
    if (!Array.isArray(sessionStartHooks)) return false;

    const hookPath = path.join(HOOK_DIR, "relay-hook.sh");
    return sessionStartHooks.some(
      (h: unknown) => isObj(h) && (h as Record<string, unknown>).command === hookPath,
    );
  } catch {
    return false;
  }
}
