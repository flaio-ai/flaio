#!/usr/bin/env node
import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./app.js";
import { listSessions, streamSession } from "./portal/portal-client.js";
import { PortalPicker } from "./portal/portal-picker.js";
import { login, logout, isLoggedIn } from "./relay/relay-auth.js";
import { settingsStore } from "./store/settings-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("agent-manager")
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
  .description("Connect to a running agent-manager session from another terminal")
  .option("-l, --list", "List available sessions")
  .action(async (sessionId: string | undefined, opts: { list?: boolean }) => {
    // Explicit --list flag → static table
    if (opts.list) {
      const sessions = await listSessions();
      if (sessions === null) {
        process.stdout.write("agent-manager is not running.\n");
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
      process.stdout.write("agent-manager is not running.\n");
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
      process.stdout.write("Already logged in. Use `agent-manager logout` to sign out first.\n");
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

program.parse(process.argv);
