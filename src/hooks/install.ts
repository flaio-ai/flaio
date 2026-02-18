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
const command = process.argv[2];

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
    event: "Stop",
    script: resolve(__dirname, "stop-hook.ts"),
    marker: "hooks/stop-hook.ts",
    timeout: 90000000,
    matcher: "",
  },
];

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

function install(): void {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

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
      console.log(`  ${hook.event} hook already installed, skipping.`);
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

    console.log(`  ${hook.event} hook installed -> ${hook.script}`);
    installed++;
  }

  writeSettings(settings);

  if (installed > 0) {
    console.log(`\nDone! ${installed} hook(s) installed.`);
  } else {
    console.log("\nAll hooks were already installed.");
  }
  console.log(`  Settings: ${settingsPath}`);
  console.log("\nHow it works:");
  console.log(
    "  - PermissionRequest: Routes to agent-manager (IPC) or Slack (fallback)",
  );
  console.log(
    "  - PostToolUse: Posts tool results via agent-manager or Slack",
  );
  console.log(
    "  - Stop: Notifies agent-manager or Slack when session ends",
  );
  console.log("\nUse 'npm run uninstall-hooks' to remove all hooks.");
}

function uninstall(): void {
  const settings = readSettings();
  if (!settings.hooks) {
    console.log("No hooks found to remove.");
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
    console.log(`  ${hook.event} hook removed.`);
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(settings);
  console.log("\nAll agent-manager hooks uninstalled.");
}

function status(): void {
  const settings = readSettings();
  console.log("Agent Manager hook status:\n");

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

switch (command) {
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  case "status":
    status();
    break;
  default:
    console.log("Usage: npx tsx src/hooks/install.ts [install|uninstall|status]");
}
