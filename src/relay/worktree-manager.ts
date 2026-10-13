// ---------------------------------------------------------------------------
// WorktreeManager — git worktree lifecycle for per-ticket isolation
// ---------------------------------------------------------------------------

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import { makeDebugLog } from "../connectors/debug.js";

const execFile = promisify(execFileCb);
const debugLog = makeDebugLog("worktree");

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Concurrency — serialize manifest read-modify-write per repo root
// ---------------------------------------------------------------------------

const manifestLocks = new Map<string, Promise<void>>();

async function withManifestLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = manifestLocks.get(repoRoot) ?? Promise.resolve();
  let resolve: (() => void) | undefined;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  manifestLocks.set(repoRoot, next);

  await prev;
  try {
    return await fn();
  } finally {
    resolve?.();
    // Clean up: if this promise is still the latest, remove the entry
    if (manifestLocks.get(repoRoot) === next) {
      manifestLocks.delete(repoRoot);
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  ticketId: string;
  branchName: string;
  worktreePath: string;
  projectCwd: string;
  createdAt: number;
}

export interface WorktreeManifest {
  worktrees: Record<string, WorktreeEntry>;
}

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a string for use as a git branch segment */
export function sanitizeBranchSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function getRepoRoot(cwd: string): Promise<string> {
  const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd });
  return stdout.trim();
}

function manifestPath(repoRoot: string): string {
  return path.join(repoRoot, ".flaio", "worktrees", "manifest.json");
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

export async function getManifest(repoRoot: string): Promise<WorktreeManifest> {
  const p = manifestPath(repoRoot);
  try {
    const text = await fsp.readFile(p, "utf-8");
    return JSON.parse(text) as WorktreeManifest;
  } catch {
    // File doesn't exist or invalid JSON
  }
  return { worktrees: {} };
}

async function writeManifest(repoRoot: string, manifest: WorktreeManifest): Promise<void> {
  const p = manifestPath(repoRoot);
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(p, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Create a git worktree for a ticket. Idempotent — returns existing worktree if one exists.
 * Returns null if cwd is not a git repo.
 */
export async function createWorktree(
  cwd: string,
  ticketId: string,
): Promise<WorktreeInfo | null> {
  try {
    if (!(await isGitRepo(cwd))) {
      debugLog(`worktree: ${cwd} is not a git repo, skipping worktree creation`);
      return null;
    }

    const repoRoot = await getRepoRoot(cwd);

    return await withManifestLock(repoRoot, async () => {
      const sanitized = sanitizeBranchSegment(ticketId);
      const branchName = `ticket/${sanitized}`;
      const worktreePath = path.join(repoRoot, ".flaio", "worktrees", sanitized);

      // Check manifest first — if entry exists, validate and return
      const manifest = await getManifest(repoRoot);
      const existing = manifest.worktrees[sanitized];
      if (existing && await pathExists(existing.worktreePath)) {
        debugLog(`worktree: reusing existing worktree for ${ticketId} at ${existing.worktreePath}`);
        return { worktreePath: existing.worktreePath, branchName: existing.branchName };
      }

      // Check if the worktree directory already exists (e.g. from a previous run)
      if (await pathExists(worktreePath)) {
        debugLog(`worktree: directory exists at ${worktreePath}, reusing`);
        // Update manifest
        manifest.worktrees[sanitized] = {
          ticketId,
          branchName,
          worktreePath,
          projectCwd: repoRoot,
          createdAt: Date.now(),
        };
        await writeManifest(repoRoot, manifest);
        return { worktreePath, branchName };
      }

      // Ensure parent directory exists
      await fsp.mkdir(path.dirname(worktreePath), { recursive: true });

      // Check if branch already exists
      let branchExists = false;
      try {
        await execFile("git", ["rev-parse", "--verify", branchName], { cwd: repoRoot });
        branchExists = true;
      } catch {
        // Branch doesn't exist yet
      }

      if (branchExists) {
        await execFile("git", ["worktree", "add", worktreePath, branchName], { cwd: repoRoot });
      } else {
        await execFile("git", ["worktree", "add", "-b", branchName, worktreePath], { cwd: repoRoot });
      }

      debugLog(`worktree: created worktree at ${worktreePath} on branch ${branchName}`);

      // Write manifest entry
      manifest.worktrees[sanitized] = {
        ticketId,
        branchName,
        worktreePath,
        projectCwd: repoRoot,
        createdAt: Date.now(),
      };
      await writeManifest(repoRoot, manifest);

      return { worktreePath, branchName };
    });
  } catch (err) {
    debugLog(`worktree: createWorktree failed: ${err}`);
    return null;
  }
}

/**
 * Auto-save uncommitted changes in a worktree with a WIP commit.
 * Returns true if a WIP commit was created.
 */
export async function autoSaveWorktree(
  worktreePath: string,
  ticketId: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFile("git", ["status", "--porcelain"], { cwd: worktreePath });
    if (!stdout.trim()) return false;

    await execFile("git", ["add", "-A"], { cwd: worktreePath });
    await execFile("git", ["commit", "-m", `WIP: auto-save for ticket ${ticketId}`], {
      cwd: worktreePath,
    });
    debugLog(`worktree: auto-saved uncommitted changes for ticket ${ticketId}`);
    return true;
  } catch (err) {
    debugLog(`worktree: autoSaveWorktree failed: ${err}`);
    return false;
  }
}

/**
 * Remove a worktree. Auto-commits dirty changes first.
 * By default keeps the branch (for PR creation).
 */
export async function removeWorktree(
  cwd: string,
  ticketId: string,
  deleteBranch = false,
): Promise<void> {
  try {
    if (!(await isGitRepo(cwd))) return;

    const repoRoot = await getRepoRoot(cwd);

    await withManifestLock(repoRoot, async () => {
      const sanitized = sanitizeBranchSegment(ticketId);
      const manifest = await getManifest(repoRoot);
      const entry = manifest.worktrees[sanitized];
      if (!entry) return;

      // Auto-commit if dirty
      if (await pathExists(entry.worktreePath)) {
        await autoSaveWorktree(entry.worktreePath, ticketId);

        // Remove the worktree — try without --force first
        try {
          await execFile("git", ["worktree", "remove", entry.worktreePath], {
            cwd: repoRoot,
          });
        } catch {
          // Fall back to --force only if normal remove fails (e.g. stale lock)
          try {
            await execFile("git", ["worktree", "remove", entry.worktreePath, "--force"], {
              cwd: repoRoot,
            });
          } catch (err) {
            debugLog(`worktree: git worktree remove --force failed: ${err}`);
          }
        }
      }

      // Optionally delete the branch
      if (deleteBranch) {
        try {
          await execFile("git", ["branch", "-D", entry.branchName], { cwd: repoRoot });
        } catch (err) {
          debugLog(`worktree: branch delete failed: ${err}`);
        }
      }

      // NOTE: Do NOT run `git worktree prune` here — it can interfere with
      // other worktrees being created concurrently. Pruning is only done at
      // startup via pruneStaleEntries().

      // Remove manifest entry
      delete manifest.worktrees[sanitized];
      await writeManifest(repoRoot, manifest);

      debugLog(`worktree: removed worktree for ticket ${ticketId}`);
    });
  } catch (err) {
    debugLog(`worktree: removeWorktree failed: ${err}`);
  }
}

/**
 * Auto-save all tracked worktrees for a given project directory.
 * Called during graceful CLI shutdown.
 */
export async function autoSaveAllWorktrees(projectCwd: string): Promise<void> {
  try {
    if (!(await isGitRepo(projectCwd))) return;

    const repoRoot = await getRepoRoot(projectCwd);
    const manifest = await getManifest(repoRoot);

    for (const [, entry] of Object.entries(manifest.worktrees)) {
      if (entry.projectCwd === repoRoot && await pathExists(entry.worktreePath)) {
        await autoSaveWorktree(entry.worktreePath, entry.ticketId);
      }
    }
  } catch (err) {
    debugLog(`worktree: autoSaveAllWorktrees failed: ${err}`);
  }
}

/**
 * Validate manifest entries against disk state. Prune stale entries.
 * Called on CLI startup.
 */
export async function pruneStaleEntries(projectCwd: string): Promise<void> {
  try {
    if (!(await isGitRepo(projectCwd))) return;

    const repoRoot = await getRepoRoot(projectCwd);
    const manifest = await getManifest(repoRoot);
    let changed = false;

    for (const [key, entry] of Object.entries(manifest.worktrees)) {
      if (!await pathExists(entry.worktreePath)) {
        debugLog(`worktree: pruning stale manifest entry for ${entry.ticketId}`);
        delete manifest.worktrees[key];
        changed = true;
      }
    }

    if (changed) {
      await writeManifest(repoRoot, manifest);
      // Also prune git's internal worktree references
      try {
        await execFile("git", ["worktree", "prune"], { cwd: repoRoot });
      } catch {
        // best effort
      }
    }
  } catch (err) {
    debugLog(`worktree: pruneStaleEntries failed: ${err}`);
  }
}

/**
 * Make sure `.flaio/` is listed in the repo's info/exclude so ticket workspace
 * files (.flaio/ticket/*) and nested worktrees never end up in commits.
 * Resolves the exclude file via `git rev-parse --git-path info/exclude`, which
 * points at the common git dir for linked worktrees. No-op outside git repos.
 * Returns true when the pattern is present afterwards.
 */
export async function ensureFlaioExcluded(cwd: string, pattern = ".flaio/"): Promise<boolean> {
  try {
    if (!(await isGitRepo(cwd))) return false;
    const { stdout } = await execFile("git", ["rev-parse", "--git-path", "info/exclude"], { cwd });
    const rel = stdout.trim();
    if (!rel) return false;
    const excludePath = path.isAbsolute(rel) ? rel : path.join(cwd, rel);

    let current = "";
    try {
      current = await fsp.readFile(excludePath, "utf-8");
    } catch {
      // Missing file — created below
    }
    const bare = pattern.replace(/\/$/, "");
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    if (lines.some((l) => l === pattern || l === bare || l === `/${bare}` || l === `/${pattern}`)) {
      return true;
    }

    await fsp.mkdir(path.dirname(excludePath), { recursive: true });
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await fsp.appendFile(excludePath, `${prefix}# Flaio ticket workspace\n${pattern}\n`, "utf-8");
    debugLog(`worktree: added ${pattern} to ${excludePath}`);
    return true;
  } catch (err) {
    debugLog(`worktree: ensureFlaioExcluded failed: ${err}`);
    return false;
  }
}
