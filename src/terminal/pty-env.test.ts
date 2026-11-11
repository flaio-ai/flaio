import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../agents/agent-session.js";
import { ClaudeDriver } from "../agents/drivers/claude-driver.js";
import { CopilotDriver } from "../agents/drivers/copilot-driver.js";
import { GeminiDriver } from "../agents/drivers/gemini-driver.js";
import { OpenCodeDriver } from "../agents/drivers/opencode-driver.js";
import { buildChildEnv, PtyManager, type PtySpawnOptions } from "./pty-manager.js";

const PARENT = { PATH: "/bin", OPENROUTER_API_KEY: "sk-or-user", ANTHROPIC_API_KEY: "sk-ant-user", OPENAI_API_KEY: "sk-oa", GITHUB_TOKEN: "ghp_x" };

describe("provider keys in agent envs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("buildChildEnv keeps only the named inherited secrets, never others", () => {
    expect(buildChildEnv(PARENT, undefined)).toEqual({ PATH: "/bin" });
    expect(buildChildEnv(PARENT, undefined, ["OPENROUTER_API_KEY"])).toEqual({ PATH: "/bin", OPENROUTER_API_KEY: "sk-or-user" });
  });

  it("only OpenCode declares inherited provider keys; Claude, Gemini and Copilot are unchanged (none)", () => {
    expect(new ClaudeDriver().inheritedSecretEnv).toEqual([]);
    expect(new GeminiDriver().inheritedSecretEnv).toEqual([]);
    expect(new CopilotDriver().inheritedSecretEnv).toEqual([]);
    expect([...new OpenCodeDriver().inheritedSecretEnv].sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
  });

  function captureSpawns(): PtySpawnOptions[] {
    const spawns: PtySpawnOptions[] = [];
    vi.spyOn(PtyManager.prototype, "spawn").mockImplementation(function (this: PtyManager, o: PtySpawnOptions) {
      spawns.push(o);
    });
    return spawns;
  }

  it("the user's interactive OpenCode session keeps its key; an untrusted PR job agent never does", async () => {
    const spawns = captureSpawns();
    const interactive = new AgentSession(new OpenCodeDriver(), { cwd: process.cwd() });
    await interactive.start({ prompt: "hi" });
    const job = new AgentSession(new OpenCodeDriver({ headless: true }), { cwd: process.cwd() });
    await job.startTicket({ sessionId: null, resume: false, permissionMode: "plan", prompt: "p", untrustedWorkspace: true, readOnly: true, print: true });
    const trustedTicket = new AgentSession(new OpenCodeDriver({ headless: true }), { cwd: process.cwd() });
    await trustedTicket.startTicket({ sessionId: null, resume: false, permissionMode: "plan", prompt: "p", print: true });
    for (const s of [interactive, job, trustedTicket]) s.kill();

    const envOf = (o: PtySpawnOptions | undefined) => buildChildEnv(PARENT, o?.env, o?.inheritSecretEnv);
    expect(spawns).toHaveLength(3);
    expect(envOf(spawns[0]).OPENROUTER_API_KEY).toBe("sk-or-user");
    expect(envOf(spawns[1]).OPENROUTER_API_KEY).toBeUndefined();
    expect(envOf(spawns[1]).ANTHROPIC_API_KEY).toBeUndefined();
    expect(envOf(spawns[2]).OPENROUTER_API_KEY).toBe("sk-or-user");
    for (const o of spawns) expect(envOf(o).GITHUB_TOKEN).toBeUndefined();
  });

  it("Claude sessions still get no inherited provider key, interactive or not", async () => {
    const spawns = captureSpawns();
    const s = new AgentSession(new ClaudeDriver(), { cwd: process.cwd() });
    await s.start({ prompt: "hi" });
    s.kill();
    expect(buildChildEnv(PARENT, spawns[0]?.env, spawns[0]?.inheritSecretEnv).ANTHROPIC_API_KEY).toBeUndefined();
  });
});
