import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookServer, defaultHookSocketDir, ensurePrivateSocketDir, getHookSocketPath } from "./hook-server.js";

const posix = process.platform !== "win32" && typeof process.getuid === "function";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flaio-hsdir-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!posix)("ensurePrivateSocketDir", () => {
  it("creates the directory owner-only", () => {
    const dir = path.join(tmp, "flaio");
    ensurePrivateSocketDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("tightens a pre-existing world-writable directory we own", () => {
    const dir = path.join(tmp, "flaio");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    ensurePrivateSocketDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a symlink planted in place of the directory", () => {
    const target = path.join(tmp, "attacker");
    fs.mkdirSync(target, { mode: 0o777 });
    const dir = path.join(tmp, "flaio");
    fs.symlinkSync(target, dir);
    expect(() => ensurePrivateSocketDir(dir)).toThrow(/not a directory owned by the current user/);
  });

  it.skipIf(process.getuid?.() !== 0)("refuses a directory owned by another user", () => {
    const dir = path.join(tmp, "flaio");
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.chownSync(dir, 12345, 12345);
    expect(() => ensurePrivateSocketDir(dir)).toThrow(/not a directory owned by the current user/);
  });
});

describe.skipIf(!posix)("hook socket path (per user)", () => {
  const saved = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME, FLAIO_HOOK_SOCKET: process.env.FLAIO_HOOK_SOCKET };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const tmpExtra: string[] = [];
  afterEach(() => {
    restore();
    for (const d of tmpExtra.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("defaults to a per-user dir and honours FLAIO_HOOK_SOCKET", () => {
    delete process.env.FLAIO_HOOK_SOCKET;
    expect(defaultHookSocketDir()).toBe(path.join(os.tmpdir(), `flaio-${process.getuid?.()}`));
    expect(getHookSocketPath()).toBe(path.join(defaultHookSocketDir(), "hooks.sock"));
    process.env.FLAIO_HOOK_SOCKET = "/x/y.sock";
    expect(getHookSocketPath()).toBe("/x/y.sock");
  });

  it("the app hook server listens on the default path and exports it for children", async () => {
    delete process.env.FLAIO_HOOK_SOCKET;
    process.env.TMPDIR = tmp;
    const server = new HookServer();
    await server.start();
    try {
      expect(server.socketPath).toBe(path.join(tmp, `flaio-${process.getuid?.()}`, "hooks.sock"));
      expect(process.env.FLAIO_HOOK_SOCKET).toBe(server.socketPath);
      expect(getHookSocketPath()).toBe(server.socketPath);
      expect(fs.statSync(path.dirname(server.socketPath)).mode & 0o777).toBe(0o700);
    } finally {
      await server.stop();
    }
  });

  it("falls back to the config dir when the default dir is not ours", async () => {
    delete process.env.FLAIO_HOOK_SOCKET;
    // Short base: unix socket paths are limited to ~104 bytes.
    const base = fs.mkdtempSync("/tmp/fhs-");
    tmpExtra.push(base);
    process.env.TMPDIR = path.join(base, "t");
    process.env.HOME = path.join(base, "h");
    fs.mkdirSync(process.env.TMPDIR);
    const attacker = path.join(base, "attacker");
    fs.mkdirSync(attacker, { mode: 0o777 });
    fs.symlinkSync(attacker, path.join(process.env.TMPDIR, `flaio-${process.getuid?.()}`));

    const server = new HookServer();
    await server.start();
    try {
      expect(server.socketPath).toBe(path.join(base, "h", ".config", "flaio", "run", "hooks.sock"));
      expect(process.env.FLAIO_HOOK_SOCKET).toBe(server.socketPath);
      expect(fs.readdirSync(attacker)).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("an explicit socketPath does not touch the process env", async () => {
    delete process.env.FLAIO_HOOK_SOCKET;
    const server = new HookServer({ socketPath: path.join(tmp, "s.sock") });
    await server.start();
    try {
      expect(process.env.FLAIO_HOOK_SOCKET).toBeUndefined();
    } finally {
      await server.stop();
    }
  });
});
