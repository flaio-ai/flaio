#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsPath = resolve(process.env.HOME, ".claude", "settings.json");
const command = process.argv[2];

const HOOKS = [
  {
    event: "PermissionRequest",
    script: resolve(__dirname, "hook.js"),
    marker: "hook.js",
    timeout: 310000,
    matcher: "",
  },
  {
    event: "PostToolUse",
    script: resolve(__dirname, "post-tool-hook.js"),
    marker: "post-tool-hook.js",
    timeout: 15000,
    matcher: "",
  },
  {
    event: "Stop",
    script: resolve(__dirname, "stop-hook.js"),
    marker: "stop-hook.js",
    timeout: 90000000,
    matcher: "",
  },
];

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function install() {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

  let installed = 0;
  for (const hook of HOOKS) {
    if (!settings.hooks[hook.event]) settings.hooks[hook.event] = [];

    const exists = settings.hooks[hook.event].some(
      (entry) => entry.hooks && entry.hooks.some((h) => h.command && h.command.includes(hook.marker))
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
          command: `node ${hook.script}`,
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
  console.log("  - PermissionRequest: Posts to Slack, blocks until you reply allow/deny");
  console.log("  - Stop: Posts to Slack when Claude finishes, reply with a new prompt to continue");
  console.log("\nUse 'npm run uninstall-hook' to remove all hooks.");
}

function uninstall() {
  const settings = readSettings();
  if (!settings.hooks) {
    console.log("No hooks found to remove.");
    return;
  }

  for (const hook of HOOKS) {
    if (!settings.hooks[hook.event]) continue;

    settings.hooks[hook.event] = settings.hooks[hook.event].filter(
      (entry) => !(entry.hooks && entry.hooks.some((h) => h.command && h.command.includes(hook.marker)))
    );

    if (settings.hooks[hook.event].length === 0) delete settings.hooks[hook.event];
    console.log(`  ${hook.event} hook removed.`);
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(settings);
  console.log("\nAll Claude Relay hooks uninstalled.");
}

function status() {
  const settings = readSettings();
  console.log("Claude Relay hook status:\n");

  for (const hook of HOOKS) {
    const installed = settings.hooks?.[hook.event]?.some(
      (entry) => entry.hooks && entry.hooks.some((h) => h.command && h.command.includes(hook.marker))
    );
    console.log(`  ${hook.event}: ${installed ? "INSTALLED" : "not installed"}`);
  }

  console.log(`\n  Settings: ${settingsPath}`);
}

switch (command) {
  case "install": install(); break;
  case "uninstall": uninstall(); break;
  case "status": status(); break;
  default:
    console.log("Usage: node src/install.js [install|uninstall|status]");
}
