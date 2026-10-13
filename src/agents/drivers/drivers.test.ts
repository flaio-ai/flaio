import { afterEach, describe, expect, it } from "vitest";
import { ClaudeDriver } from "./claude-driver.js";
import { GeminiDriver } from "./gemini-driver.js";
import { CopilotDriver } from "./copilot-driver.js";
import { settingsStore } from "../../store/settings-store.js";

const SID = "11111111-1111-4111-8111-111111111111";
const FORK = "22222222-2222-4222-8222-222222222222";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("ClaudeDriver.buildTicketSpawnArgs", () => {
  const driver = new ClaudeDriver();
  const base = { cwd: "/repo", prompt: "do it", permissionMode: "plan" as const };

  it("first run presets the session id", () => {
    const cfg = driver.buildTicketSpawnArgs({ ...base, sessionId: SID, resume: false });
    expect(flagValue(cfg.args, "--session-id")).toBe(SID);
    expect(cfg.args).not.toContain("--resume");
    expect(cfg.agentSessionId).toBe(SID);
    expect(cfg.resumed).toBe(false);
  });

  it("later runs resume the same id without --session-id", () => {
    const cfg = driver.buildTicketSpawnArgs({ ...base, sessionId: SID, resume: true, permissionMode: "acceptEdits" });
    expect(flagValue(cfg.args, "--resume")).toBe(SID);
    expect(cfg.args).not.toContain("--session-id");
    expect(cfg.args).not.toContain("--fork-session");
    expect(cfg.agentSessionId).toBe(SID);
    expect(cfg.resumed).toBe(true);
  });

  it("fork resumes with --fork-session and an optional preset id", () => {
    const cfg = driver.buildTicketSpawnArgs({
      ...base,
      sessionId: SID,
      resume: true,
      forkSession: true,
      forkSessionId: FORK,
    });
    expect(flagValue(cfg.args, "--resume")).toBe(SID);
    expect(cfg.args).toContain("--fork-session");
    expect(flagValue(cfg.args, "--session-id")).toBe(FORK);
    expect(cfg.agentSessionId).toBe(FORK);

    const noPreset = driver.buildTicketSpawnArgs({ ...base, sessionId: SID, resume: true, forkSession: true });
    expect(noPreset.args).not.toContain("--session-id");
    expect(noPreset.agentSessionId).toBeNull();
  });

  it.each([
    ["plan", "plan"],
    ["acceptEdits", "acceptEdits"],
    ["default", "default"],
  ] as const)("maps permission mode %s", (mode, flag) => {
    const cfg = driver.buildTicketSpawnArgs({ ...base, sessionId: SID, resume: false, permissionMode: mode });
    expect(flagValue(cfg.args, "--permission-mode")).toBe(flag);
  });

  it("passes model, MCP config, system prompt and print mode; prompt follows --", () => {
    const cfg = driver.buildTicketSpawnArgs({
      ...base,
      prompt: "-starts with a dash",
      sessionId: SID,
      resume: false,
      model: "claude-opus-4-6",
      mcpConfigPath: "/tmp/flaio-mcp.json",
      settingsPath: "/tmp/flaio-settings.json",
      appendSystemPrompt: "  Be careful.  ",
      allowedTools: ["Read", "Grep"],
      print: true,
    });
    expect(flagValue(cfg.args, "--model")).toBe("claude-opus-4-6");
    // `=` form: the variadic --mcp-config must not take the next argument as another config.
    expect(cfg.args).toContain("--mcp-config=/tmp/flaio-mcp.json");
    expect(cfg.args).not.toContain("--mcp-config");
    expect(flagValue(cfg.args, "--settings")).toBe("/tmp/flaio-settings.json");
    expect(flagValue(cfg.args, "--append-system-prompt")).toBe("Be careful.");
    expect(flagValue(cfg.args, "--allowedTools")).toBe("Read,Grep");
    expect(cfg.args).toContain("-p");
    // The variadic --mcp-config / --allowedTools must not swallow the prompt.
    expect(cfg.args.slice(-2)).toEqual(["--", "-starts with a dash"]);
  });

  it("omits optional flags when not given", () => {
    const cfg = driver.buildTicketSpawnArgs({ ...base, sessionId: null, resume: false });
    for (const flag of ["--session-id", "--resume", "--settings", "--append-system-prompt", "--model", "-p"]) {
      expect(cfg.args).not.toContain(flag);
    }
    expect(cfg.args.some((a) => a.startsWith("--mcp-config"))).toBe(false);
    expect(cfg.agentSessionId).toBeNull();
  });
});

describe("GeminiDriver.buildTicketSpawnArgs (best effort)", () => {
  const driver = new GeminiDriver();

  it("cannot preset ids: first run is fresh, system prompt inlined, mcp ignored", () => {
    const cfg = driver.buildTicketSpawnArgs({
      cwd: "/repo",
      sessionId: SID,
      resume: false,
      permissionMode: "acceptEdits",
      prompt: "go",
      appendSystemPrompt: "SYS",
      mcpConfigPath: "/tmp/x.json",
      settingsPath: "/tmp/s.json",
    });
    expect(cfg.agentSessionId).toBeNull();
    expect(cfg.args).not.toContain("--resume");
    expect(cfg.args.join(" ")).not.toContain("/tmp/x.json");
    expect(cfg.args.join(" ")).not.toContain("/tmp/s.json");
    expect(flagValue(cfg.args, "--approval-mode")).toBe("auto_edit");
    expect(flagValue(cfg.args, "-i")).toMatch(/^SYS[\s\S]*go$/);
  });

  it("resumes a known id", () => {
    const cfg = driver.buildTicketSpawnArgs({ cwd: "/repo", sessionId: "abc", resume: true, permissionMode: "plan", prompt: "go" });
    expect(flagValue(cfg.args, "--resume")).toBe("abc");
    expect(flagValue(cfg.args, "--approval-mode")).toBe("plan");
    expect(cfg.resumed).toBe(true);
    expect(cfg.agentSessionId).toBe("abc");
  });
});

describe("BaseDriver fallback (Copilot)", () => {
  it("starts a fresh session with the brief prompt and no session flags", () => {
    const driver = new CopilotDriver();
    expect(driver.ticketCapabilities.resume).toBe(false);
    const cfg = driver.buildTicketSpawnArgs({
      cwd: "/repo",
      sessionId: SID,
      resume: true,
      permissionMode: "acceptEdits",
      prompt: "go",
      appendSystemPrompt: "SYS",
    });
    expect(cfg.resumed).toBe(false);
    expect(cfg.agentSessionId).toBeNull();
    expect(cfg.args).not.toContain("--resume");
    expect(cfg.args.at(-1)).toMatch(/^SYS[\s\S]*go$/);
  });
});

describe("listModels", () => {
  const original = settingsStore.getState().config;
  afterEach(() => settingsStore.setState({ config: original }));

  it("uses the built-in list by default", () => {
    settingsStore.setState({ config: { ...original, agents: { ...original.agents, models: {} } } });
    expect(new ClaudeDriver().listModels().map((m) => m.id)).toContain("claude-sonnet-4-6");
  });

  it("uses agents.models[<driver>] from config when set", () => {
    settingsStore.setState({
      config: {
        ...original,
        agents: { ...original.agents, models: { claude: [{ id: "claude-x", displayName: "X" }] } },
      },
    });
    expect(new ClaudeDriver().listModels()).toEqual([{ id: "claude-x", displayName: "X" }]);
    expect(new GeminiDriver().listModels().length).toBeGreaterThan(0);
  });
});
