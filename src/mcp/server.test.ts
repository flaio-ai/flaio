import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAIO_MCP_TOOLS } from "../contracts/mcp-tools.js";
import { ticketPhaseBus } from "../contracts/ticket-phase-bus.js";
import { HookServer } from "../hooks/hook-server.js";
import { readWorkspace, writeBrief } from "../workspace/ticket-workspace.js";
import { createFlaioMcpServer, createProcessToolCaller, resolveMcpRuntimeConfig, type ToolCaller } from "./server.js";
import { _clearMcpSessions, registerMcpSession } from "./session-registry.js";

let wt: string;

beforeEach(() => {
  wt = fs.mkdtempSync(path.join(os.tmpdir(), "flaio-mcp-test-"));
  _clearMcpSessions();
});

afterEach(() => {
  fs.rmSync(wt, { recursive: true, force: true });
  ticketPhaseBus.removeAllListeners();
});

async function connect(callTool: ToolCaller) {
  const server = createFlaioMcpServer({ callTool, version: "test" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, server };
}

describe("Flaio MCP server", () => {
  it("registers exactly the contract tools", async () => {
    const { client } = await connect(async () => ({ ok: true }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(FLAIO_MCP_TOOLS).sort());
    for (const t of tools) expect(t.description).toBeTruthy();
  });

  it("validates input and passes parsed data (with defaults) to the caller", async () => {
    const calls: unknown[] = [];
    const { client } = await connect(async (tool, input) => {
      calls.push({ tool, input });
      return { ok: true };
    });
    const ok = await client.callTool({ name: "complete_phase", arguments: { result: "success", summary: "done" } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toEqual({ ok: true });
    expect(calls).toEqual([{ tool: "complete_phase", input: { result: "success", summary: "done", testsRun: [] } }]);

    const bad = await client.callTool({ name: "complete_phase", arguments: { result: "maybe", summary: "x" } });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("surfaces caller errors as tool errors", async () => {
    const { client } = await connect(async () => {
      throw new Error("boom");
    });
    const r = await client.callTool({ name: "get_ticket_context", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("boom");
  });

  it("standalone mode persists to the workspace (no CLI)", async () => {
    await writeBrief(wt, "Standalone brief");
    const cfg = resolveMcpRuntimeConfig({ ticket: "t1" }, { FLAIO_TICKET_WORKTREE: wt }, "/nowhere");
    const { client } = await connect(createProcessToolCaller(cfg));
    await client.callTool({ name: "record_decision", arguments: { title: "D", rationale: "R" } });
    const ctx = await client.callTool({ name: "get_ticket_context", arguments: {} });
    expect(ctx.structuredContent).toMatchObject({ ticketId: "t1", briefMarkdown: "Standalone brief\n" });
    expect((ctx.structuredContent as { decisionsMarkdown: string }).decisionsMarkdown).toContain("## D");
  });

  it("standalone mode picks the ticket from workspace state, errors when unbound", async () => {
    const unbound = resolveMcpRuntimeConfig({ ticket: "${FLAIO_TICKET_ID}" }, {}, wt);
    expect(unbound.ticketId).toBeNull();
    const { client } = await connect(createProcessToolCaller(unbound));
    const r = await client.callTool({ name: "get_ticket_context", arguments: {} });
    expect(r.isError).toBe(true);

    await writeBrief(wt, "b", { ticketId: "from-state", jobId: null });
    const r2 = await client.callTool({ name: "get_ticket_context", arguments: {} });
    expect(r2.structuredContent).toMatchObject({ ticketId: "from-state" });
  });

  it("bridged mode forwards over the hook server and emits on the ticketPhaseBus", async () => {
    const socketPath = path.join(os.tmpdir(), `flaio-hs-${process.pid}-${Date.now()}.sock`);
    const hookServer = new HookServer({ socketPath });
    await hookServer.start();
    try {
      const token = registerMcpSession({ ticketId: "t42", jobId: "j42", worktreePath: wt });
      const received: unknown[] = [];
      ticketPhaseBus.onEvent("plan_submitted", (p) => received.push(p));
      ticketPhaseBus.onEvent("phase_complete", (p) => received.push(p));

      const cfg = resolveMcpRuntimeConfig({}, { FLAIO_MCP_TOKEN: token, FLAIO_HOOK_SOCKET: socketPath }, "/unused");
      const { client } = await connect(createProcessToolCaller(cfg));

      const r = await client.callTool({ name: "submit_plan", arguments: { steps: ["one"], markdown: "# P" } });
      expect(r.isError).toBeFalsy();
      await client.callTool({ name: "complete_phase", arguments: { result: "success", summary: "planned" } });

      expect(received).toEqual([
        { ticketId: "t42", jobId: "j42", plan: { steps: ["one"], risks: [], files: [], markdown: "# P" } },
        { ticketId: "t42", jobId: "j42", completion: { result: "success", summary: "planned", testsRun: [] } },
      ]);
      expect((await readWorkspace(wt)).plan).toBe("# P\n");

      // Wrong token → rejected by the CLI endpoint, no event.
      const badCfg = { ...cfg, token: "f".repeat(64) };
      const { client: bad } = await connect(createProcessToolCaller(badCfg));
      const denied = await bad.callTool({ name: "report_progress", arguments: { step: "x", status: "done" } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toMatch(/token/i);
      expect(received).toHaveLength(2);
    } finally {
      await hookServer.stop();
    }
  });
});
