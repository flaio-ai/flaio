import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedSensitiveKeys,
  parseConfigList,
  runSafeGit,
  safeConfigArgs,
  safeGitEnv,
  setRunnerGitToken,
  snapshotRepoConfig,
} from "./safe-git.js";

const TRUSTED = {
  common: ["user.name=Dev", "user.email=dev@example.com"],
  credentials: ["credential.helper=osxkeychain"],
};

describe("safeGitEnv", () => {
  it("drops inherited GIT_* (except ssh settings) and turns global/system config off", () => {
    const env = safeGitEnv({
      PATH: "/bin",
      HOME: "/home/u",
      GIT_DIR: "/evil",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "/evil.sh",
      GIT_EXTERNAL_DIFF: "/evil.sh",
      GIT_ASKPASS: "/evil.sh",
      GIT_SSH_COMMAND: "ssh -i key",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i key");
    expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" });
  });
});

describe("safeConfigArgs", () => {
  afterEach(() => setRunnerGitToken(null));

  it("neutralises program-executing keys and gives credentials only to auth calls", () => {
    const plain = safeConfigArgs({ trusted: TRUSTED });
    for (const k of ["core.fsmonitor=false", "core.hooksPath=/dev/null", "core.pager=cat", "diff.external=", "credential.helper=", "submodule.recurse=false", "protocol.ext.allow=never"]) {
      expect(plain).toContain(k);
    }
    expect(plain).toContain("user.name=Dev");
    expect(plain).not.toContain("credential.helper=osxkeychain");
    const auth = safeConfigArgs({ trusted: TRUSTED, auth: true });
    // The reset comes first, then only the trusted helper.
    expect(auth.indexOf("credential.helper=osxkeychain")).toBeGreaterThan(auth.indexOf("credential.helper="));
  });

  it("with a runner token, auth calls use no helper at all (the token goes as a one-call header)", () => {
    setRunnerGitToken("ghs_secret");
    expect(safeConfigArgs({ trusted: TRUSTED, auth: true })).not.toContain("credential.helper=osxkeychain");
  });
});

describe("runSafeGit with a fake git", () => {
  let tmp: string;
  let log: string;
  const savedPath = process.env.PATH;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flaio-safegit-")));
    log = path.join(tmp, "log");
    // Records argv and the env a real git would see.
    fs.writeFileSync(
      path.join(tmp, "git"),
      `#!/bin/sh\n{ echo "ARGS $*"; echo "HDR \${GIT_CONFIG_VALUE_0:-none}"; echo "TOK \${GITHUB_TOKEN_FLAIO_RUNNER:-none}"; echo "GLOBAL \${GIT_CONFIG_GLOBAL:-unset}"; echo "DIR \${GIT_DIR:-unset}"; } >> "${log}"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tmp}:${savedPath}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    setRunnerGitToken(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("hands the runner token to fetch/push calls only, as a header, never via process.env", async () => {
    setRunnerGitToken("ghs_secret_token");
    await runSafeGit(tmp, ["status"]);
    await runSafeGit(tmp, ["add", "-A"]);
    await runSafeGit(tmp, ["fetch", "origin"], { auth: true });
    const lines = fs.readFileSync(log, "utf-8").trim().split("\n");
    const hdr = lines.filter((l) => l.startsWith("HDR "));
    expect(hdr[0]).toBe("HDR none");
    expect(hdr[1]).toBe("HDR none");
    const basic = Buffer.from("x-access-token:ghs_secret_token").toString("base64");
    expect(hdr[2]).toBe(`HDR AUTHORIZATION: basic ${basic}`);
    expect(lines.filter((l) => l.startsWith("TOK ")).every((l) => l === "TOK none")).toBe(true);
    expect(lines.filter((l) => l.startsWith("GLOBAL ")).every((l) => l === "GLOBAL /dev/null")).toBe(true);
    expect(JSON.stringify(process.env)).not.toContain("ghs_secret_token");
  });

  it("passes an explicit GIT_DIR so a worktree's .git file is never consulted", async () => {
    await runSafeGit(tmp, ["status"], { gitDir: "/repo/.git/worktrees/x", workTree: tmp });
    expect(fs.readFileSync(log, "utf-8")).toContain("DIR /repo/.git/worktrees/x");
  });
});

describe("repo config snapshots", () => {
  it("parses -z lists, blanks program keys with arbitrary names and detects changes", async () => {
    expect(parseConfigList("core.bare\nfalse\0remote.origin.url\nx\0")).toEqual([
      ["core.bare", "false"],
      ["remote.origin.url", "x"],
    ]);
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flaio-safegit-")));
    try {
      execFileSync("git", ["init", "-q", tmp]);
      execFileSync("git", ["-C", tmp, "config", "filter.MyFilter.smudge", "evil"]);
      execFileSync("git", ["-C", tmp, "config", "diff.pdf.textconv", "evil"]);
      execFileSync("git", ["-C", tmp, "config", "remote.origin.uploadpack", "evil"]);
      const before = await snapshotRepoConfig(tmp);
      expect(before.blanks).toEqual(expect.arrayContaining(["filter.MyFilter.smudge=", "diff.pdf.textconv=", "remote.origin.uploadpack=git-upload-pack"]));
      execFileSync("git", ["-C", tmp, "config", "credential.helper", "!evil"]);
      execFileSync("git", ["-C", tmp, "config", "branch.main.description", "harmless"]);
      const after = await snapshotRepoConfig(tmp);
      expect(changedSensitiveKeys(before, after)).toEqual(["credential.helper"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
