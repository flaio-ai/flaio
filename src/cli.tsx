#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./app.js";

const program = new Command();

program
  .name("agent-manager")
  .description("Terminal UI for managing multiple AI CLI agents")
  .version("0.1.0")
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

program.parse(process.argv);
