#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsPath = resolve(
  process.env.HOME ?? "~",
  ".claude",
  "settings.json",
);

const HOOKS = [
  {
    event: "PermissionRequest",
    script: resolve(__dirname, "hook.ts"),
    marker: "hooks/hook.ts",
    timeout: 310000,
    matcher: "",
  },
  {
    event: "PostToolUse",
    script: resolve(__dirname, "post-tool-hook.ts"),
    marker: "hooks/post-tool-hook.ts",
    timeout: 15000,
    matcher: "",
  },
  {
    event: "Notification",
    script: resolve(__dirname, "notification-hook.ts"),
    marker: "hooks/notification-hook.ts",
    timeout: 15000,
    matcher: "",
  },
];

// Markers for legacy hooks that should be replaced
const LEGACY_MARKERS = ["src/hook.js", "src/stop-hook.js", "src/post-tool-hook.js", "hooks/stop-hook.ts"];

function readSettings(): Record<string, any> {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, any>): void {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
    "utf-8",
  );
}

function removeLegacyHooks(settings: Record<string, any>): number {
  if (!settings.hooks) return 0;
  let removed = 0;

  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(
      (entry: any) =>
        !(
          entry.hooks &&
          entry.hooks.some((h: any) =>
            LEGACY_MARKERS.some((m) => h.command && h.command.includes(m)),
          )
        ),
    );
    removed += before - settings.hooks[event].length;

    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

export interface InstallOptions {
  silent?: boolean;
}

export function installHooks(opts?: InstallOptions): void {
  const silent = opts?.silent ?? false;
  const log = silent ? () => {} : console.log.bind(console);

  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

  // Remove legacy hooks that bypass IPC
  const legacyRemoved = removeLegacyHooks(settings);
  if (legacyRemoved > 0) {
    log(`  Removed ${legacyRemoved} legacy hook(s).`);
    if (!settings.hooks) settings.hooks = {};
  }

  let installed = 0;
  for (const hook of HOOKS) {
    if (!settings.hooks[hook.event]) settings.hooks[hook.event] = [];

    const exists = settings.hooks[hook.event].some(
      (entry: any) =>
        entry.hooks &&
        entry.hooks.some(
          (h: any) => h.command && h.command.includes(hook.marker),
        ),
    );

    if (exists) {
      log(`  ${hook.event} hook already installed, skipping.`);
      continue;
    }

    settings.hooks[hook.event].push({
      matcher: hook.matcher,
      hooks: [
        {
          type: "command",
          command: `npx tsx ${hook.script}`,
          timeout: hook.timeout,
        },
      ],
    });

    log(`  ${hook.event} hook installed -> ${hook.script}`);
    installed++;
  }

  writeSettings(settings);

  if (installed > 0 || legacyRemoved > 0) {
    log(`\nDone! ${installed} hook(s) installed, ${legacyRemoved} legacy hook(s) removed.`);
  } else {
    log("\nAll hooks were already installed.");
  }
}

export function uninstallHooks(opts?: InstallOptions): void {
  const silent = opts?.silent ?? false;
  const log = silent ? () => {} : console.log.bind(console);

  const settings = readSettings();
  if (!settings.hooks) {
    log("No hooks found to remove.");
    return;
  }

  for (const hook of HOOKS) {
    if (!settings.hooks[hook.event]) continue;

    settings.hooks[hook.event] = settings.hooks[hook.event].filter(
      (entry: any) =>
        !(
          entry.hooks &&
          entry.hooks.some(
            (h: any) => h.command && h.command.includes(hook.marker),
          )
        ),
    );

    if (settings.hooks[hook.event].length === 0)
      delete settings.hooks[hook.event];
    log(`  ${hook.event} hook removed.`);
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(settings);
  log("\nAll flaio hooks uninstalled.");
}

export function hookStatus(): void {
  const settings = readSettings();
  console.log("Flaio hook status:\n");

  for (const hook of HOOKS) {
    const installed = settings.hooks?.[hook.event]?.some(
      (entry: any) =>
        entry.hooks &&
        entry.hooks.some(
          (h: any) => h.command && h.command.includes(hook.marker),
        ),
    );
    console.log(
      `  ${hook.event}: ${installed ? "INSTALLED" : "not installed"}`,
    );
  }

  console.log(`\n  Settings: ${settingsPath}`);
}

// CLI entry point — only runs when executed directly
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]).replace(/\.[^.]+$/, "") ===
    fileURLToPath(import.meta.url).replace(/\.[^.]+$/, "");

if (isMain) {
  const command = process.argv[2];
  switch (command) {
    case "install":
      installHooks();
      break;
    case "uninstall":
      uninstallHooks();
      break;
    case "status":
      hookStatus();
      break;
    default:
      console.log(
        "Usage: npx tsx src/hooks/install.ts [install|uninstall|status]",
      );
  }
}
