#!/usr/bin/env node
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
import { login, logout, isLoggedIn } from "./relay/relay-auth.js";
import { settingsStore } from "./store/settings-store.js";
import {
  installHookScripts,
  getClaudeHooksConfig,
  getClaudeStatusLineConfig,
  getGeminiHooksConfig,
  mergeSettingsFile,
  areClaudeHooksConfigured,
  areGeminiHooksConfigured,
} from "./agents/sideband/hook-scripts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("flaio")
  .description("Terminal UI for managing multiple AI CLI agents")
  .version(pkg.version)
  .action(() => {
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

    // Clean up on exit
    instance.waitUntilExit().then(() => {
      cleanup();
      process.exit(0);
    });

    process.on("SIGINT", () => {
      instance.unmount();
    });

    process.on("SIGTERM", () => {
      instance.unmount();
    });
  });

program
  .command("portal [sessionId]")
  .description("Connect to a running flaio session from another terminal")
  .option("-l, --list", "List available sessions")
  .action(async (sessionId: string | undefined, opts: { list?: boolean }) => {
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

program.parse(process.argv);
