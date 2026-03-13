#!/usr/bin/env node
process.title = "flaio";

import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./app.js";
import { listSessions, streamSession } from "./portal/portal-client.js";
import { PortalPicker } from "./portal/portal-picker.js";
import {
  login,
  logout,
  isLoggedIn,
  getAuthToken,
  extractUidFromToken,
  extractEmailFromToken,
} from "./relay/relay-auth.js";
import { settingsStore } from "./store/settings-store.js";
import { initAnalytics, shutdownAnalytics, trackCliEvent, startHeartbeat } from "./analytics/index.js";
import {
  installHookScripts,
  getClaudeHooksConfig,
  getClaudeStatusLineConfig,
  getGeminiHooksConfig,
  mergeSettingsFile,
  areClaudeHooksConfigured,
  areGeminiHooksConfigured,
} from "./agents/sideband/hook-scripts.js";
import { parseSettingValue, setNestedValue, checkLatestVersion } from "./cli-utils.js";
import { listTickets, getTicket, updateTicket } from "./api/ticket-client.js";
import { appStore } from "./store/app-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

// Expose version and PID to child processes and diagnostics
process.env.FLAIO_VERSION = pkg.version;
process.env.FLAIO_PID = String(process.pid);

const program = new Command();

// Initialize analytics early (before command parsing)
initAnalytics();

program
  .name("flaio")
  .description("Terminal UI for managing multiple AI CLI agents")
  .version(pkg.version, "-v, --version")
  .action(() => {
    trackCliEvent("cli_session_started");
    // Set terminal window/tab title
    process.stdout.write(`\x1b]0;flaio v${pkg.version}\x07`);
    // Enter alternate screen buffer (like vim/less) so we own the full screen
    process.stdout.write("\x1B[?1049h");
    // Hide the hardware cursor — agents render their own cursor in ANSI output
    process.stdout.write("\x1B[?25l");
    // Enable SGR extended mouse mode for wheel scroll support
    // (hold Shift to select text in most terminal emulators)
    process.stdout.write("\x1B[?1000h");
    process.stdout.write("\x1B[?1006h");

    const cleanup = () => {
      // Disable mouse reporting
      process.stdout.write("\x1B[?1006l");
      process.stdout.write("\x1B[?1000l");
      // Show cursor and exit alternate screen buffer
      process.stdout.write("\x1B[?25h");
      process.stdout.write("\x1B[?1049l");
    };

    const instance = render(<App />, {
      exitOnCtrlC: false,
      maxFps: 15,
    });

    // Start crash-recovery heartbeat with session count getter
    startHeartbeat(() => appStore.getState().sessions.length);

    // Clean up on exit
    instance.waitUntilExit().then(async () => {
      cleanup();
      // Stop relay client, connectors, and hook server before analytics flush
      const { stopConnectors } = await import("./store/connector-store.js");
      await stopConnectors().catch(() => {});
      await shutdownAnalytics();
      process.exit(0);
    });

    process.on("SIGINT", () => {
      instance.unmount();
    });

    process.on("SIGTERM", () => {
      cleanup();
      process.stderr.write("[flaio] Received SIGTERM, shutting down...\n");
      instance.unmount();
    });
  });

program
  .command("portal [sessionId]")
  .description("Connect to a running flaio session from another terminal")
  .option("-l, --list", "List available sessions")
  .action(async (sessionId: string | undefined, opts: { list?: boolean }) => {
    trackCliEvent("cli_command_executed", { command: "portal" });
    // Explicit --list flag → static table
    if (opts.list) {
      const sessions = await listSessions();
      if (sessions === null) {
        process.stdout.write("flaio is not running.\n");
        process.exit(1);
      }
      if (sessions.length === 0) {
        process.stdout.write("No active sessions.\n");
        process.exit(0);
      }
      // Table header
      process.stdout.write(
        `${"ID".padEnd(14)} ${"DRIVER".padEnd(12)} ${"STATUS".padEnd(16)} CWD\n`,
      );
      process.stdout.write(`${"─".repeat(14)} ${"─".repeat(12)} ${"─".repeat(16)} ${"─".repeat(30)}\n`);
      for (const s of sessions) {
        process.stdout.write(
          `${s.id.padEnd(14)} ${s.displayName.padEnd(12)} ${s.status.padEnd(16)} ${s.cwd}\n`,
        );
      }
      process.exit(0);
    }

    // Explicit session ID → stream directly
    if (sessionId) {
      await streamSession(sessionId);
      return;
    }

    // No session ID, no --list → interactive picker
    const sessions = await listSessions();
    if (sessions === null) {
      process.stdout.write("flaio is not running.\n");
      process.exit(1);
    }

    const cwd = process.cwd();
    let selectedId: string | null = null;
    const instance = render(
      <PortalPicker
        cwd={cwd}
        onSelect={(id: string) => {
          selectedId = id;
          instance.unmount();
        }}
      />,
    );

    await instance.waitUntilExit();

    if (selectedId) {
      await streamSession(selectedId);
    }
  });

program
  .command("login")
  .description("Authenticate with the remote relay service")
  .action(async () => {
    trackCliEvent("cli_command_executed", { command: "login" });
    // Ensure settings are loaded
    if (!settingsStore.getState().loaded) {
      settingsStore.getState().load();
    }

    if (isLoggedIn()) {
      process.stdout.write("Already logged in. Use `flaio logout` to sign out first.\n");
      process.exit(0);
    }

    const result = await login();
    if (result.success) {
      // Enable relay by default after login
      settingsStore.getState().updateRelay({ enabled: true });
      process.stdout.write("Logged in successfully. Remote access is now enabled.\n");
      process.exit(0);
    } else {
      process.stderr.write(`Login failed: ${result.error}\n`);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Sign out from the remote relay service")
  .action(() => {
    trackCliEvent("cli_command_executed", { command: "logout" });
    // Ensure settings are loaded
    if (!settingsStore.getState().loaded) {
      settingsStore.getState().load();
    }

    if (!isLoggedIn()) {
      process.stdout.write("Not logged in.\n");
      process.exit(0);
    }

    logout();
    settingsStore.getState().updateRelay({ enabled: false });
    process.stdout.write("Logged out. Remote access has been disabled.\n");
    process.exit(0);
  });

program
  .command("setup-hooks")
  .description("Install sideband hook scripts for Claude Code and Gemini CLI")
  .option("--claude-only", "Only configure Claude Code hooks")
  .option("--gemini-only", "Only configure Gemini CLI hooks")
  .option("--check", "Check if hooks are already configured")
  .action(async (opts: { claudeOnly?: boolean; geminiOnly?: boolean; check?: boolean }) => {
    trackCliEvent("cli_command_executed", { command: "setup-hooks" });
    if (opts.check) {
      const [claudeOk, geminiOk] = await Promise.all([
        areClaudeHooksConfigured(),
        areGeminiHooksConfigured(),
      ]);
      process.stdout.write(`Claude Code hooks: ${claudeOk ? "configured" : "not configured"}\n`);
      process.stdout.write(`Gemini CLI hooks:  ${geminiOk ? "configured" : "not configured"}\n`);
      process.exit(0);
    }

    try {
      // 1. Install hook scripts to disk
      const { hookPath, statusLinePath } = await installHookScripts();
      process.stdout.write(`Hook scripts installed:\n  ${hookPath}\n  ${statusLinePath}\n\n`);

      // 2. Merge into Claude Code settings
      if (!opts.geminiOnly) {
        const claudeSettingsPath = path.join(
          process.env.HOME ?? os.homedir(),
          ".claude",
          "settings.json",
        );
        const hooksCfg = getClaudeHooksConfig(hookPath);
        const statusLineCfg = getClaudeStatusLineConfig(statusLinePath);
        await mergeSettingsFile(claudeSettingsPath, { ...hooksCfg, ...statusLineCfg });
        process.stdout.write(`Claude Code settings updated: ${claudeSettingsPath}\n`);
      }

      // 3. Merge into Gemini CLI settings
      if (!opts.claudeOnly) {
        const geminiSettingsPath = path.join(
          process.env.HOME ?? os.homedir(),
          ".gemini",
          "settings.json",
        );
        const geminiCfg = getGeminiHooksConfig(hookPath);
        await mergeSettingsFile(geminiSettingsPath, geminiCfg);
        process.stdout.write(`Gemini CLI settings updated:  ${geminiSettingsPath}\n`);
      }

      process.stdout.write("\nHooks configured successfully. Existing hooks have been preserved.\n");
      process.stdout.write("Hook scripts are no-ops when not running under flaio.\n");
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to setup hooks: ${message}\n`);
      process.exit(1);
    }
  });

// ── helpers ──────────────────────────────────────────────────────────
function ensureLoaded() {
  if (!settingsStore.getState().loaded) {
    settingsStore.getState().load();
  }
}

function ensureLoggedIn() {
  if (!isLoggedIn()) {
    process.stderr.write("Not logged in. Run `flaio login` first.\n");
    process.exit(1);
  }
}

// ── settings ─────────────────────────────────────────────────────────
const settingsCmd = program
  .command("settings")
  .description("View or update CLI settings")
  .action(() => {
    trackCliEvent("cli_command_executed", { command: "settings" });
    ensureLoaded();
    const { config } = settingsStore.getState();
    const display = JSON.parse(JSON.stringify(config));
    if (display.relay?.authToken) display.relay.authToken = "••••••••";
    if (display.relay?.refreshToken) display.relay.refreshToken = "••••••••";
    process.stdout.write(JSON.stringify(display, null, 2) + "\n");
    process.exit(0);
  });

const PROTECTED_KEYS = ["relay.authToken", "relay.refreshToken"];

settingsCmd
  .command("set <key> <value>")
  .description("Update a setting (use dot notation, e.g. ui.showCost true)")
  .action((key: string, value: string) => {
    trackCliEvent("cli_command_executed", { command: "settings set" });
    ensureLoaded();

    if (PROTECTED_KEYS.includes(key)) {
      process.stderr.write(`Cannot set ${key} — managed by login/logout\n`);
      process.exit(1);
    }

    const parsed = parseSettingValue(value);
    const config = structuredClone(settingsStore.getState().config);

    try {
      setNestedValue(config as unknown as Record<string, unknown>, key, parsed);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
      process.exit(1);
    }

    settingsStore.getState().update(config);
    process.stdout.write(`Set ${key} = ${JSON.stringify(parsed)}\n`);
    process.exit(0);
  });

// ── status ───────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show CLI status: user info, hooks, update availability")
  .action(async () => {
    trackCliEvent("cli_command_executed", { command: "status" });
    ensureLoaded();

    process.stdout.write(`flaio v${pkg.version}\n\n`);

    const token = getAuthToken();
    if (token) {
      const uid = extractUidFromToken(token);
      const email = extractEmailFromToken(token);
      process.stdout.write(`Logged in:  yes\n`);
      if (email) process.stdout.write(`Email:      ${email}\n`);
      if (uid) process.stdout.write(`User ID:    ${uid}\n`);
    } else {
      process.stdout.write(`Logged in:  no\n`);
    }

    const { config } = settingsStore.getState();
    process.stdout.write(`Relay:      ${config.relay.enabled ? "enabled" : "disabled"}\n`);
    process.stdout.write(`Relay URL:  ${config.relay.relayUrl}\n\n`);

    const [claudeOk, geminiOk] = await Promise.all([
      areClaudeHooksConfigured(),
      areGeminiHooksConfigured(),
    ]);
    process.stdout.write(`Claude hooks:  ${claudeOk ? "installed" : "not installed"}\n`);
    process.stdout.write(`Gemini hooks:  ${geminiOk ? "installed" : "not installed"}\n\n`);

    const latestVersion = await checkLatestVersion();
    if (latestVersion && latestVersion !== pkg.version) {
      process.stdout.write(`Update available: ${pkg.version} → ${latestVersion}\n`);
      process.stdout.write(`Run: npm install -g flaio-cli\n`);
    } else {
      process.stdout.write(`Up to date\n`);
    }

    process.exit(0);
  });

// ── tickets ──────────────────────────────────────────────────────────
const ticketsCmd = program
  .command("tickets")
  .description("List and manage tickets");

ticketsCmd
  .command("list")
  .description("List tickets")
  .option("-c, --column <column>", "Filter by column (backlog, planning, in_progress, etc.)")
  .option("-s, --search <term>", "Search in title and description")
  .option("-l, --limit <number>", "Max results", "20")
  .option("--json", "Output raw JSON")
  .action(async (opts: { column?: string; search?: string; limit: string; json?: boolean }) => {
    trackCliEvent("cli_command_executed", { command: "tickets list" });
    ensureLoaded();
    ensureLoggedIn();

    try {
      const { tickets } = await listTickets({
        column: opts.column,
        search: opts.search,
        limit: parseInt(opts.limit, 10),
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(tickets, null, 2) + "\n");
        process.exit(0);
      }

      if (tickets.length === 0) {
        process.stdout.write("No tickets found.\n");
        process.exit(0);
      }

      process.stdout.write(
        `${"ID".padEnd(24)} ${"COLUMN".padEnd(14)} ${"TITLE"}\n`,
      );
      process.stdout.write(
        `${"─".repeat(24)} ${"─".repeat(14)} ${"─".repeat(40)}\n`,
      );
      for (const t of tickets) {
        const id = String(t.id);
        const displayId = id.length > 22 ? id.slice(0, 22) + "…" : id;
        const title = String(t.title ?? "");
        const displayTitle = title.length > 50 ? title.slice(0, 50) + "…" : title;
        process.stdout.write(
          `${displayId.padEnd(24)} ${String(t.column || "—").padEnd(14)} ${displayTitle}\n`,
        );
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
      process.exit(1);
    }
  });

ticketsCmd
  .command("get <id>")
  .description("Get ticket details")
  .option("--json", "Output raw JSON")
  .action(async (id: string, opts: { json?: boolean }) => {
    trackCliEvent("cli_command_executed", { command: "tickets get" });
    ensureLoaded();
    ensureLoggedIn();

    try {
      const { ticket } = await getTicket(id);

      if (opts.json) {
        process.stdout.write(JSON.stringify(ticket, null, 2) + "\n");
        process.exit(0);
      }

      process.stdout.write(`Title:       ${ticket.title}\n`);
      process.stdout.write(`ID:          ${ticket.id}\n`);
      process.stdout.write(`Column:      ${ticket.column}\n`);
      process.stdout.write(`Agent:       ${ticket.agent || "—"}\n`);
      process.stdout.write(`Model:       ${ticket.model || "—"}\n`);
      process.stdout.write(`CWD:         ${ticket.cwd || "—"}\n`);
      const gitContext = ticket.gitContext as Record<string, unknown> | undefined;
      process.stdout.write(`Branch:      ${gitContext?.branch || ticket.worktreeBranch || "—"}\n`);
      process.stdout.write(`PR:          ${gitContext?.prUrl || "—"}\n`);
      process.stdout.write(`Updated:     ${new Date(ticket.updatedAt as number).toLocaleString()}\n`);
      if (ticket.description) {
        process.stdout.write(`\nDescription:\n${ticket.description}\n`);
      }
      if (ticket.plan) {
        process.stdout.write(`\nPlan:\n${ticket.plan}\n`);
      }
      const deliverables = ticket.deliverables as Array<{ checked: boolean; label: string }> | undefined;
      if (deliverables?.length) {
        process.stdout.write(`\nDeliverables:\n`);
        for (const d of deliverables) {
          process.stdout.write(`  ${d.checked ? "[x]" : "[ ]"} ${d.label}\n`);
        }
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
      process.exit(1);
    }
  });

ticketsCmd
  .command("update <id>")
  .description("Update a ticket")
  .option("--title <title>", "Set title")
  .option("--description <desc>", "Set description")
  .option("--column <column>", "Move to column")
  .option("--plan <plan>", "Set plan text")
  .option("--cwd <path>", "Set working directory")
  .option("--agent <agent>", "Set agent driver (claude, gemini)")
  .option("--model <model>", "Set model")
  .option("--implementation-details <details>", "Set implementation details")
  .option("--json", "Output updated ticket as JSON")
  .action(async (id: string, opts: Record<string, string | boolean | undefined>) => {
    trackCliEvent("cli_command_executed", { command: "tickets update" });
    ensureLoaded();
    ensureLoggedIn();

    const updates: Record<string, unknown> = {};
    if (opts.title) updates.title = opts.title;
    if (opts.description) updates.description = opts.description;
    if (opts.column) updates.column = opts.column;
    if (opts.plan) updates.plan = opts.plan;
    if (opts.cwd) updates.cwd = opts.cwd;
    if (opts.agent) updates.agent = opts.agent;
    if (opts.model) updates.model = opts.model;
    if (opts.implementationDetails) updates.implementationDetails = opts.implementationDetails;

    if (Object.keys(updates).length === 0) {
      process.stderr.write("No fields to update. Use --title, --column, etc.\n");
      process.exit(1);
    }

    try {
      const { ticket } = await updateTicket(id, updates);

      if (opts.json) {
        process.stdout.write(JSON.stringify(ticket, null, 2) + "\n");
      } else {
        process.stdout.write(`Updated ticket ${id}\n`);
        for (const [key, val] of Object.entries(updates)) {
          process.stdout.write(`  ${key}: ${JSON.stringify(val)}\n`);
        }
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
      process.exit(1);
    }
  });

program.parse(process.argv);
