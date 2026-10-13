import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateSocketDir } from "./hook-server.js";

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
