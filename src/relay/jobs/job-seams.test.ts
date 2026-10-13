import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultTicketWorkspace } from "./job-seams.js";

let root: string;
let worktree: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flaio-seams-"));
  worktree = path.join(root, "wt");
  outside = path.join(root, "outside");
  await fs.mkdir(worktree);
  await fs.mkdir(outside);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("defaultTicketWorkspace.writeBrief", () => {
  it("writes .flaio/ticket/brief.md inside the worktree", async () => {
    const file = await defaultTicketWorkspace.writeBrief(worktree, "# B", { ticketId: "t1", jobId: "j1" });
    expect(file).toBe(path.join(worktree, ".flaio/ticket/brief.md"));
    expect(await fs.readFile(file, "utf-8")).toBe("# B\n");
    // Overwrites on the next run.
    await defaultTicketWorkspace.writeBrief(worktree, "# C\n", { ticketId: "t1", jobId: "j2" });
    expect(await fs.readFile(file, "utf-8")).toBe("# C\n");
  });

  it("refuses a .flaio symlink pointing outside the worktree", async () => {
    await fs.symlink(outside, path.join(worktree, ".flaio"));
    await expect(defaultTicketWorkspace.writeBrief(worktree, "# B", { ticketId: "t1", jobId: null })).rejects.toThrow(/not a plain directory/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses a brief.md symlink pointing at another file", async () => {
    const victim = path.join(outside, "victim");
    await fs.writeFile(victim, "keep me");
    await fs.mkdir(path.join(worktree, ".flaio/ticket"), { recursive: true });
    await fs.symlink(victim, path.join(worktree, ".flaio/ticket/brief.md"));
    await expect(defaultTicketWorkspace.writeBrief(worktree, "# B", { ticketId: "t1", jobId: null })).rejects.toThrow();
    expect(await fs.readFile(victim, "utf-8")).toBe("keep me");
  });
});
