import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OPENCODE,
  OpenCodeDriver,
  buildOpenCodeConfig,
  mcpServersFromClaudeConfig,
  toOpenCodeModel,
} from "./opencode-driver.js";

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-test-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

interface OcConfig {
  mcp: { servers: Record<string, { command: string[] }> };
}

function readConfig(env: Record<string, string> | undefined): OcConfig {
  const home = env?.[OPENCODE.configHomeEnv] ?? "";
  expect(home).toBeTruthy();
  return JSON.parse(fs.readFileSync(path.join(home, OPENCODE.configRelPath), "utf-8")) as OcConfig;
}

describe("toOpenCodeModel", () => {
  it("prefixes bare ids with the provider", () => {
    expect(toOpenCodeModel("claude-sonnet-5", "anthropic")).toBe("anthropic/claude-sonnet-5");
    expect(toOpenCodeModel("gpt-6", "openai")).toBe("openai/gpt-6");
  });
  it("always prefixes OpenRouter slugs, once", () => {
    expect(toOpenCodeModel("anthropic/claude-x", "openrouter")).toBe("openrouter/anthropic/claude-x");
    expect(toOpenCodeModel("openrouter/anthropic/claude-x", "openrouter")).toBe("openrouter/anthropic/claude-x");
  });
  it("passes prefixed ids through and leaves ids alone without a provider", () => {
    expect(toOpenCodeModel("anthropic/claude-x", "anthropic")).toBe("anthropic/claude-x");
    expect(toOpenCodeModel("whatever/model")).toBe("whatever/model");
  });
});

describe("OpenCode config", () => {
  it("translates the Flaio MCP config into mcp.servers", () => {
    const servers = mcpServersFromClaudeConfig({
      mcpServers: { flaio: { command: "/usr/bin/node", args: ["cli.js", "mcp"], env: { FLAIO_MCP_TOKEN: "t" } } },
    });
    expect(servers).toEqual({
      flaio: { type: "local", command: ["/usr/bin/node", "cli.js", "mcp"], environment: { FLAIO_MCP_TOKEN: "t" } },
    });
  });

  it("denies edits in plan mode only and disables updates", () => {
    const plan = buildOpenCodeConfig({ permissionMode: "plan" });
    expect(plan.permissions).toEqual([{ action: OPENCODE.editAction, resource: "*", effect: "deny" }]);
    expect(plan.update).toBe("disable");
    expect(buildOpenCodeConfig({ permissionMode: "acceptEdits" }).permissions).toEqual([]);
  });
});

describe("OpenCodeDriver.buildTicketSpawnArgs (headless)", () => {
  const driver = () => new OpenCodeDriver({ headless: true, provider: "openrouter", tmpDir: tmp });

  it("builds an unattended `run` with agent, model and the prompt last", () => {
    const cfg = driver().buildTicketSpawnArgs({
      cwd: repo,
      sessionId: null,
      resume: false,
      permissionMode: "plan",
      prompt: "review the PR",
      model: "anthropic/claude-x",
    });
    expect(cfg.args.slice(0, 4)).toEqual(["run", "--standalone", "--format", "json"]);
    expect(flagValue(cfg.args, "--agent")).toBe("plan");
    expect(cfg.args).toContain("--auto");
    expect(flagValue(cfg.args, "--model")).toBe("openrouter/anthropic/claude-x");
    expect(cfg.args.at(-1)).toBe("review the PR");
    expect(cfg.resumed).toBe(false);
    expect(cfg.agentSessionId).toBeNull();
  });

  it("uses the build agent for acceptEdits and inlines system instructions", () => {
    const cfg = driver().buildTicketSpawnArgs({
      cwd: repo,
      sessionId: null,
      resume: false,
      permissionMode: "acceptEdits",
      prompt: "fix it",
      appendSystemPrompt: "Be careful",
    });
    expect(flagValue(cfg.args, "--agent")).toBe("build");
    expect(cfg.args.at(-1)).toBe("Be careful\n\n---\n\nfix it");
  });

  it("writes MCP + permissions to a private config home outside the worktree, never the key", () => {
    const mcpPath = path.join(tmp, "mcp.json");
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { flaio: { command: "node", args: ["x"], env: { A: "1" } } } }));
    const cfg = driver().buildTicketSpawnArgs({
      cwd: repo,
      sessionId: null,
      resume: false,
      permissionMode: "plan",
      prompt: "p",
      mcpConfigPath: mcpPath,
    });
    const home = cfg.env?.[OPENCODE.configHomeEnv] ?? "";
    expect(home.startsWith(repo)).toBe(false);
    expect((fs.statSync(home).mode & 0o777).toString(8)).toBe("700");
    const config = readConfig(cfg.env);
    expect(config.mcp.servers.flaio.command).toEqual(["node", "x"]);
    expect(JSON.stringify(config)).not.toMatch(/API_KEY/);
    expect(fs.readdirSync(repo)).toEqual([]);
    // No secret ever goes into argv.
    expect(cfg.args.join(" ")).not.toMatch(/API_KEY|sk-/);
  });

  it("guards prompts that look like flags", () => {
    const cfg = driver().buildTicketSpawnArgs({ cwd: repo, sessionId: null, resume: false, permissionMode: "plan", prompt: "--rm" });
    expect(cfg.args.at(-1)).toBe(" --rm");
  });

  it("refuses repositories that ship their own OpenCode config", () => {
    fs.writeFileSync(path.join(repo, "opencode.json"), "{}");
    expect(() =>
      driver().buildTicketSpawnArgs({ cwd: repo, sessionId: null, resume: false, permissionMode: "plan", prompt: "p" }),
    ).toThrow(/OpenCode config/);
  });

  it("fails clearly when the MCP config is unreadable", () => {
    expect(() =>
      driver().buildTicketSpawnArgs({
        cwd: repo,
        sessionId: null,
        resume: false,
        permissionMode: "plan",
        prompt: "p",
        mcpConfigPath: path.join(tmp, "missing.json"),
      }),
    ).toThrow(/Flaio MCP config/);
  });
});

describe("OpenCodeDriver basics", () => {
  it("has no hard-coded model list and is registered", async () => {
    expect(new OpenCodeDriver().listModels()).toEqual([]);
    const { getDriver } = await import("../agent-registry.js");
    expect(getDriver("opencode")).toBeInstanceOf(OpenCodeDriver);
  });

  it("interactive spawn starts the TUI with the model and first prompt", () => {
    const cfg = new OpenCodeDriver({ provider: "anthropic" }).buildSpawnArgs({ cwd: repo, model: "claude-x", prompt: "hi" });
    expect(cfg.args).toEqual(["--model", "anthropic/claude-x", "--prompt", "hi"]);
  });

  it("interactive ticket runs use a private server and pass the prompt by flag", () => {
    const cfg = new OpenCodeDriver({ tmpDir: tmp }).buildTicketSpawnArgs({
      cwd: repo,
      sessionId: null,
      resume: false,
      permissionMode: "acceptEdits",
      prompt: "go",
    });
    expect(cfg.args).toEqual(["--standalone", "--agent", "build", "--prompt", "go"]);
  });

  it("headless status: running until long silence", () => {
    const d = new OpenCodeDriver({ headless: true });
    expect(d.detectStatus("", 1000)).toBe("running");
    expect(d.detectStatus("", 200_000)).toBe("idle");
  });
});
