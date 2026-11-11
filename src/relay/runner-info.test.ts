import { describe, expect, it } from "vitest";
import { buildRunnerRegisterMsg, collectRepos, getCliVersion, normalizeRepoUrl } from "./runner-info.js";
import { RelayToCliMsgSchema } from "./relay-message-schemas.js";

describe("normalizeRepoUrl", () => {
  it.each([
    ["git@github.com:Flaio-AI/flaio.git", "github.com/flaio-ai/flaio"],
    ["https://github.com/flaio-ai/flaio", "github.com/flaio-ai/flaio"],
    ["https://user@github.com/flaio-ai/flaio.git", "github.com/flaio-ai/flaio"],
    ["ssh://git@gitlab.example.com:2222/team/app.git", "gitlab.example.com:2222/team/app"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeRepoUrl(input)).toBe(expected);
  });
});

describe("buildRunnerRegisterMsg", () => {
  it("reports id, drivers, normalized unique repos, concurrency and version", async () => {
    const origins: Record<string, string | null> = {
      "/a": "git@github.com:org/one.git",
      "/b": "https://github.com/org/one",
      "/c": null,
    };
    const msg = await buildRunnerRegisterMsg({
      runnerId: "runner-1",
      drivers: ["claude"],
      projectCwds: ["/a", "/b", "/c", "/a"],
      maxConcurrent: 2.7,
      hostname: "box",
      cliVersion: "9.9.9",
      getOrigin: async (cwd) => origins[cwd] ?? null,
    });
    expect(msg).toEqual({
      type: "cli_runner_register",
      runner: {
        id: "runner-1",
        orgId: null,
        kind: "local",
        hostname: "box",
        drivers: ["claude"],
        repos: ["github.com/org/one"],
        maxConcurrent: 2,
        cliVersion: "9.9.9",
      },
    });
  });

  it("tolerates failing git lookups", async () => {
    expect(await collectRepos(["/x"], async () => Promise.reject(new Error("boom")))).toEqual([]);
  });

  it("reads the CLI version from package.json", () => {
    const saved = process.env.FLAIO_VERSION;
    delete process.env.FLAIO_VERSION;
    try {
      expect(getCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      if (saved !== undefined) process.env.FLAIO_VERSION = saved;
    }
  });
});

describe("relay_run_job schema", () => {
  it("keeps the Stage 2 job fields", () => {
    const parsed = RelayToCliMsgSchema.parse({
      type: "relay_run_job",
      job: {
        id: "j1",
        ticketId: "t1",
        ownerUid: "u",
        orgId: null,
        kind: "plan",
        prompt: null,
        permissionMode: "plan",
        status: "claimed",
        runnerId: "r",
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        error: null,
        createdAt: 1,
        updatedAt: 1,
        availableAt: null,
        runOptions: { iteration: 2, useWorktree: true },
        result: null,
      },
      ticket: { id: "t1", title: "T", cwd: "~/x", useWorktree: true, driverName: "claude", model: null, agentSession: null },
      briefMarkdown: "# B",
      systemInstructions: [],
    });
    expect(parsed.type === "relay_run_job" && parsed.job.runOptions).toEqual({ iteration: 2, useWorktree: true });
  });
});
