import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendProgress, startPhase, writeBrief } from "../workspace/ticket-workspace.js";
import { decideStop, runStopHook } from "./stop-hook.js";

let wt: string;
// Point IPC at a socket that doesn't exist so the notify is a no-op.
const baseEnv = { FLAIO_HOOK_SOCKET: "/nonexistent/flaio.sock" };

beforeEach(() => {
  wt = fs.mkdtempSync(path.join(os.tmpdir(), "flaio-stop-test-"));
  process.env.FLAIO_HOOK_SOCKET = baseEnv.FLAIO_HOOK_SOCKET;
});

afterEach(() => {
  fs.rmSync(wt, { recursive: true, force: true });
  delete process.env.FLAIO_HOOK_SOCKET;
});

describe("stop hook decision", () => {
  it("is a no-op outside ticket sessions", async () => {
    await writeBrief(wt, "b");
    expect(await decideStop({ cwd: wt }, { ...baseEnv })).toEqual({ block: false, reason: "not_ticket" });
    expect(await runStopHook(JSON.stringify({ cwd: wt }), { ...baseEnv })).toBeNull();
  });

  it("does nothing without a workspace", async () => {
    expect(await decideStop({ cwd: wt }, { ...baseEnv, FLAIO_TICKET_ID: "t" })).toMatchObject({ reason: "no_workspace" });
  });

  it("blocks once when progress.md was not updated this phase, never twice", async () => {
    const env = { ...baseEnv, FLAIO_TICKET_ID: "t", FLAIO_TICKET_WORKTREE: wt };
    await appendProgress(wt, "old note from a previous phase");
    await startPhase(wt, { ticketId: "t", jobId: "j", at: Date.now() + 1000 });

    const out = await runStopHook(JSON.stringify({ cwd: "/somewhere/else", stop_hook_active: false }), env);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toMatch(/progress\.md/);

    // Claude continues because of the block: stop_hook_active=true → allow.
    expect(await decideStop({ cwd: wt, stop_hook_active: true }, env)).toEqual({ block: false, reason: "stop_hook_active" });
    // Even if the flag is missing, the same phase is never blocked again.
    expect(await decideStop({ cwd: wt }, env)).toEqual({ block: false, reason: "already_blocked" });

    // A new phase may block again.
    await startPhase(wt, { jobId: "j2", at: Date.now() + 5000 });
    expect((await decideStop({ cwd: wt }, env)).block).toBe(true);
  });

  it("allows the stop when progress.md was updated during the phase", async () => {
    const env = { ...baseEnv, FLAIO_TICKET_ID: "t" };
    await writeBrief(wt, "brief", { ticketId: "t", jobId: "j" });
    expect((await decideStop({ cwd: wt }, env)).block).toBe(true);

    await startPhase(wt, { at: Date.now() - 10_000 });
    await appendProgress(wt, "Handoff: done X, next Y");
    expect(await decideStop({ cwd: wt }, env)).toEqual({ block: false, reason: "progress_updated" });
  });

  it("ignores malformed stdin", async () => {
    expect(await runStopHook("not json", { ...baseEnv, FLAIO_TICKET_ID: "t" })).toBeNull();
  });
});
