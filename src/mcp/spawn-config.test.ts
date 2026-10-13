import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildMcpConfigJson, disposeMcpSpawnConfig, getMcpSpawnConfig, nodeInvocation, type McpSpawnConfig } from "./spawn-config.js";
import { _clearMcpSessions, resolveMcpSession } from "./session-registry.js";

const created: McpSpawnConfig[] = [];

afterEach(() => {
  for (const c of created.splice(0)) disposeMcpSpawnConfig(c);
  _clearMcpSessions();
});

describe("getMcpSpawnConfig", () => {
  it("writes a Claude Code --mcp-config file pointing at `flaio mcp` with the session token", () => {
    const cfg = getMcpSpawnConfig("ticket-1", "job-1", {
      worktreePath: "/repo/wt",
      socketPath: "/tmp/x.sock",
      nodePath: "/usr/bin/node",
      cliEntry: "/opt/flaio/dist/cli.js",
    });
    created.push(cfg);

    const json = JSON.parse(fs.readFileSync(cfg.mcpConfigPath, "utf-8"));
    expect(json).toEqual({
      mcpServers: {
        flaio: {
          command: "/usr/bin/node",
          args: ["/opt/flaio/dist/cli.js", "mcp", "--ticket", "ticket-1", "--job", "job-1"],
          env: {
            FLAIO_MCP_TOKEN: cfg.token,
            FLAIO_HOOK_SOCKET: "/tmp/x.sock",
            FLAIO_TICKET_ID: "ticket-1",
            FLAIO_JOB_ID: "job-1",
            FLAIO_TICKET_WORKTREE: "/repo/wt",
          },
        },
      },
    });
    expect(fs.statSync(cfg.mcpConfigPath).mode & 0o077).toBe(0);
    expect(resolveMcpSession(cfg.token)).toMatchObject({ ticketId: "ticket-1", jobId: "job-1", worktreePath: "/repo/wt" });
    expect(cfg.env).toEqual({
      FLAIO_TICKET_ID: "ticket-1",
      FLAIO_JOB_ID: "job-1",
      FLAIO_TICKET_WORKTREE: "/repo/wt",
      FLAIO_MCP_TOKEN: cfg.token,
      FLAIO_HOOK_SOCKET: "/tmp/x.sock",
    });
  });

  it("writes a --settings file with the Stop hook", () => {
    const cfg = getMcpSpawnConfig("t", null);
    created.push(cfg);
    const settings = JSON.parse(fs.readFileSync(cfg.settingsPath, "utf-8"));
    const cmd: string = settings.hooks.Stop[0].hooks[0].command;
    expect(settings.hooks.Stop[0].hooks[0].type).toBe("command");
    expect(cmd).toMatch(/stop-hook\.(ts|js)'$/);
    expect(settings.hooks.Stop[0].matcher).toBeUndefined();
  });

  it("omits --job when there is no job and uses fresh tokens", () => {
    const a = getMcpSpawnConfig("t", null);
    const b = getMcpSpawnConfig("t", null);
    created.push(a, b);
    expect(a.token).not.toBe(b.token);
    const json = JSON.parse(fs.readFileSync(a.mcpConfigPath, "utf-8"));
    expect(json.mcpServers.flaio.args.slice(-3)).toEqual(["mcp", "--ticket", "t"]);
    expect(json.mcpServers.flaio.env.FLAIO_JOB_ID).toBeUndefined();
  });

  it("dispose revokes the token and removes the files", () => {
    const cfg = getMcpSpawnConfig("t", "j");
    disposeMcpSpawnConfig(cfg);
    expect(resolveMcpSession(cfg.token)).toBeNull();
    expect(fs.existsSync(cfg.dir)).toBe(false);
  });

  it("runs TypeScript entries through the tsx loader", () => {
    const inv = nodeInvocation("/src/cli.tsx", "/node");
    expect(inv.command).toBe("/node");
    expect(inv.args[0]).toBe("--import");
    expect(inv.args[1]).toMatch(/tsx/);
    expect(inv.args[2]).toBe("/src/cli.tsx");
    expect(nodeInvocation("/dist/cli.js", "/node")).toEqual({ command: "/node", args: ["/dist/cli.js"] });
  });

  it("buildMcpConfigJson is deterministic for a given token", () => {
    const j = buildMcpConfigJson("t", "j", "tok", { nodePath: "n", cliEntry: "c.js", socketPath: "s" });
    expect(j.mcpServers.flaio.env.FLAIO_MCP_TOKEN).toBe("tok");
  });
});
