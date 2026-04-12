import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process before importing drivers
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { ClaudeDriver } from "../src/agents/drivers/claude-driver.js";
import { GeminiDriver } from "../src/agents/drivers/gemini-driver.js";

const mockedExecFileSync = vi.mocked(execFileSync);

describe("ClaudeDriver custom command", () => {
  let driver: ClaudeDriver;

  beforeEach(() => {
    driver = new ClaudeDriver();
    vi.clearAllMocks();
  });

  it("effectiveCommand returns default 'claude' when no custom command set", () => {
    expect(driver.effectiveCommand).toBe("claude");
  });

  it("setCustomCommand sets effectiveCommand to the custom value", () => {
    driver.setCustomCommand("custom-claude");
    expect(driver.effectiveCommand).toBe("custom-claude");
  });

  it("setCustomCommand(undefined) resets effectiveCommand to default", () => {
    driver.setCustomCommand("custom-claude");
    driver.setCustomCommand(undefined);
    expect(driver.effectiveCommand).toBe("claude");
  });

  it("setCustomCommand('') is treated as undefined (returns default)", () => {
    driver.setCustomCommand("");
    expect(driver.effectiveCommand).toBe("claude");
  });

  it("setCustomCommand trims whitespace", () => {
    driver.setCustomCommand("  spaces  ");
    expect(driver.effectiveCommand).toBe("spaces");
  });

  it("resolveCommand uses effectiveCommand for 'which' lookup", () => {
    driver.setCustomCommand("custom-claude");
    mockedExecFileSync.mockReturnValue("/usr/local/bin/custom-claude\n");

    const resolved = driver.resolveCommand();

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "which",
      ["custom-claude"],
      { encoding: "utf-8" },
    );
    expect(resolved).toBe("/usr/local/bin/custom-claude");
  });

  it("resolveCommand returns effectiveCommand when 'which' fails", () => {
    driver.setCustomCommand("missing-cmd");
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const resolved = driver.resolveCommand();
    expect(resolved).toBe("missing-cmd");
  });

  it("checkInstalled uses effectiveCommand", async () => {
    driver.setCustomCommand("custom-claude");
    mockedExecFileSync.mockReturnValue("" as any);

    const installed = await driver.checkInstalled();

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "which",
      ["custom-claude"],
      { stdio: "ignore" },
    );
    expect(installed).toBe(true);
  });

  it("checkInstalled returns false when effectiveCommand not found", async () => {
    driver.setCustomCommand("nonexistent");
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const installed = await driver.checkInstalled();
    expect(installed).toBe(false);
  });

  it("buildSpawnArgs uses resolved effectiveCommand", () => {
    driver.setCustomCommand("custom-claude");
    mockedExecFileSync.mockReturnValue("/opt/bin/custom-claude\n");

    const config = driver.buildSpawnArgs({ cwd: "/tmp" });
    expect(config.command).toBe("/opt/bin/custom-claude");
  });
});

describe("GeminiDriver custom command", () => {
  let driver: GeminiDriver;

  beforeEach(() => {
    driver = new GeminiDriver();
    vi.clearAllMocks();
  });

  it("effectiveCommand returns default 'gemini' when no custom command set", () => {
    expect(driver.effectiveCommand).toBe("gemini");
  });

  it("setCustomCommand sets effectiveCommand to the custom value", () => {
    driver.setCustomCommand("custom-gemini");
    expect(driver.effectiveCommand).toBe("custom-gemini");
  });

  it("setCustomCommand(undefined) resets effectiveCommand to default", () => {
    driver.setCustomCommand("custom-gemini");
    driver.setCustomCommand(undefined);
    expect(driver.effectiveCommand).toBe("gemini");
  });

  it("setCustomCommand('') is treated as undefined (returns default)", () => {
    driver.setCustomCommand("");
    expect(driver.effectiveCommand).toBe("gemini");
  });

  it("setCustomCommand trims whitespace", () => {
    driver.setCustomCommand("  my-gemini  ");
    expect(driver.effectiveCommand).toBe("my-gemini");
  });

  it("resolveCommand uses effectiveCommand", () => {
    driver.setCustomCommand("custom-gemini");
    mockedExecFileSync.mockReturnValue("/usr/bin/custom-gemini\n");

    const resolved = driver.resolveCommand();

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "which",
      ["custom-gemini"],
      { encoding: "utf-8" },
    );
    expect(resolved).toBe("/usr/bin/custom-gemini");
  });

  it("checkInstalled uses effectiveCommand", async () => {
    driver.setCustomCommand("custom-gemini");
    mockedExecFileSync.mockReturnValue("" as any);

    const installed = await driver.checkInstalled();

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "which",
      ["custom-gemini"],
      { stdio: "ignore" },
    );
    expect(installed).toBe(true);
  });

  it("checkInstalled returns false when effectiveCommand not found", async () => {
    driver.setCustomCommand("nonexistent");
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const installed = await driver.checkInstalled();
    expect(installed).toBe(false);
  });
});
