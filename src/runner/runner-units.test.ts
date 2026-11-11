import { describe, expect, it } from "vitest";
import { ALLOW_SECRET_ENV_MARKER, buildChildEnv } from "../terminal/pty-manager.js";
import { providerSessionEnv } from "./agent-env.js";
import { CREDENTIAL_HELPER, RUNNER_GIT_TOKEN_ENV, authHeaderEnv, redact, shallowClone, type GitExec } from "./git-checkout.js";
import { readRunnerConfig, RUNNER_ENV } from "./runner-config.js";
import { UsageCollector } from "./usage.js";
import { resolveCloudCwd } from "./command.js";

describe("agent env: provider key allow path", () => {
  it("scrubs inherited provider keys and runner secrets", () => {
    const env = buildChildEnv(
      { PATH: "/bin", OPENROUTER_API_KEY: "leak", ANTHROPIC_API_KEY: "leak", [RUNNER_GIT_TOKEN_ENV]: "gh", FLAIO_RUNNER_TOKEN: "t" },
      undefined,
    );
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("drops explicit sensitive keys unless the explicit env names them", () => {
    expect(buildChildEnv({}, { GITHUB_TOKEN: "x", FOO: "1" })).toEqual({ FOO: "1" });
    const env = buildChildEnv(
      { ANTHROPIC_API_KEY: "parent" },
      { ...providerSessionEnv({ provider: "openrouter", providerApiKey: "sk-or-1" }), GITHUB_TOKEN: "x" },
    );
    expect(env).toEqual({ OPENROUTER_API_KEY: "sk-or-1" });
    expect(env[ALLOW_SECRET_ENV_MARKER]).toBeUndefined();
  });

  it("maps each provider to its key variable", () => {
    expect(Object.keys(providerSessionEnv({ provider: "anthropic", providerApiKey: "k" }))).toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(providerSessionEnv({ provider: "openai", providerApiKey: "k" }))).toContain("OPENAI_API_KEY");
  });
});

describe("UsageCollector", () => {
  it("counts each step part once, summing across parts", () => {
    const u = new UsageCollector();
    u.push('{"type":"step_finish","part":{"id":"prt_1","messageID":"m1","tokens":{"input":5,"output":1},"cost":0.1}}\n');
    u.push('{"type":"step_finish","part":{"id":"prt_2","messageID":"m1","tokens":{"input":7,"output":2},"cost":0.2}}\n');
    u.push('{"type":"step_finish","part":{"id":"prt_2","messageID":"m1","tokens":{"input":7,"output":2},"cost":0.2}}\n');
    expect(u.total()).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(u.total().costUsd).toBeCloseTo(0.3);
  });

  it("sums tokens and cost per message, counting cumulative updates once", () => {
    const u = new UsageCollector();
    u.push('{"type":"step","part":{"messageID":"m1","tokens":{"input":10,"output":5,"cache":{"read":2}},"cost":0.01}}\n');
    u.push('{"type":"step","part":{"messageID":"m1","tokens":{"input":20,"output":8,"cache":{"read":3}},"cost":0.02}}\n{"type":"te');
    u.push('xt","part":{"messageID":"m2","tokens":{"input":1,"output":1,"reasoning":1},"cost":0.005}}\nnot json\n');
    u.flush();
    expect(u.total()).toEqual({ inputTokens: 21, outputTokens: 10, cacheReadTokens: 3, costUsd: 0.025 });
  });

  it("reports zero and a null cost when nothing matches", () => {
    const u = new UsageCollector();
    u.push("plain output\n");
    expect(u.total()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null });
  });
});

describe("shallowClone", () => {
  it("passes the token only through the git process env, then installs an env-reading helper", async () => {
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const git: GitExec = async (args, opts) => {
      calls.push({ args, env: opts.env });
      return { stdout: "" };
    };
    const dir = "/tmp/flaio-runner-test-nonexistent";
    const target = await shallowClone({ repository: "acme/web", token: "ghs_SECRET", dir, git, baseEnv: { PATH: "/bin" } });
    expect(target).toBe(`${dir}/web`);
    const clone = calls[0];
    expect(clone.args).toContain("https://github.com/acme/web.git");
    expect(clone.args.join(" ")).not.toContain("ghs_SECRET");
    expect(clone.args).toContain("--depth");
    expect(clone.env?.GIT_CONFIG_VALUE_0).toBe(authHeaderEnv("ghs_SECRET").GIT_CONFIG_VALUE_0);
    expect(clone.env?.GIT_TERMINAL_PROMPT).toBe("0");
    const helper = calls.find((c) => c.args.includes("credential.https://github.com.helper"));
    expect(helper?.args).toContain(CREDENTIAL_HELPER);
    expect(CREDENTIAL_HELPER).not.toContain("ghs_SECRET");
    expect(CREDENTIAL_HELPER).toContain(RUNNER_GIT_TOKEN_ENV);
  });

  it("rejects odd repository names and redacts the token from errors", async () => {
    await expect(shallowClone({ repository: "../x", token: null, dir: "/tmp/x" })).rejects.toThrow(/Invalid repository/);
    const git: GitExec = async () => {
      throw Object.assign(new Error("boom"), { stderr: "fatal: auth ghs_SECRET failed" });
    };
    await expect(
      shallowClone({ repository: "acme/web", token: "ghs_SECRET", dir: "/tmp/flaio-runner-test-nonexistent", git }),
    ).rejects.toThrow(/fatal: auth \*\*\* failed/);
    expect(redact("a ghs_SECRET b", "ghs_SECRET")).toBe("a *** b");
  });
});

describe("readRunnerConfig", () => {
  it("validates and removes the token from the env", () => {
    const env: NodeJS.ProcessEnv = {
      [RUNNER_ENV.token]: "frt_abc",
      [RUNNER_ENV.relayUrl]: "wss://api.flaio.ai",
      [RUNNER_ENV.jobId]: "job_1",
    };
    const cfg = readRunnerConfig(env);
    expect(cfg.token).toBe("frt_abc");
    expect(env[RUNNER_ENV.token]).toBeUndefined();
  });

  it("fails on missing or bad values", () => {
    expect(() => readRunnerConfig({})).toThrow(/Missing/);
    expect(() =>
      readRunnerConfig({ [RUNNER_ENV.token]: "t", [RUNNER_ENV.relayUrl]: "http://x", [RUNNER_ENV.jobId]: "j" }),
    ).toThrow(/ws/);
  });
});

describe("resolveCloudCwd", () => {
  it("maps the empty PR cwd to the clone and blocks escapes", () => {
    expect(resolveCloudCwd("", "/w/repo")).toBe("/w/repo");
    expect(resolveCloudCwd("sub", "/w/repo")).toBe("/w/repo/sub");
    expect(() => resolveCloudCwd("../other", "/w/repo")).toThrow(/outside/);
  });
});
