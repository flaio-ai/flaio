// ---------------------------------------------------------------------------
// WorktreeManager — git worktree lifecycle for per-ticket isolation
// ---------------------------------------------------------------------------

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { makeDebugLog } from "../connectors/debug.js";

const execFile = promisify(execFileCb);
const debugLog = makeDebugLog("worktree");

// ---------------------------------------------------------------------------
// Concurrency — serialize manifest read-modify-write per repo root
// ---------------------------------------------------------------------------

const manifestLocks = new Map<string, Promise<void>>();

async function withManifestLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = manifestLocks.get(repoRoot) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  manifestLocks.set(repoRoot, next);

  await prev;
  try {
    return await fn();
  } finally {
    resolve!();
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

export function getManifest(repoRoot: string): WorktreeManifest {
  const p = manifestPath(repoRoot);
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      return raw as WorktreeManifest;
    }
  } catch (err) {
    debugLog(`worktree: failed to read manifest: ${err}`);
  }
  return { worktrees: {} };
}

function writeManifest(repoRoot: string, manifest: WorktreeManifest): void {
  const p = manifestPath(repoRoot);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
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
      const manifest = getManifest(repoRoot);
      const existing = manifest.worktrees[sanitized];
      if (existing && fs.existsSync(existing.worktreePath)) {
        debugLog(`worktree: reusing existing worktree for ${ticketId} at ${existing.worktreePath}`);
        return { worktreePath: existing.worktreePath, branchName: existing.branchName };
      }

      // Check if the worktree directory already exists (e.g. from a previous run)
      if (fs.existsSync(worktreePath)) {
        debugLog(`worktree: directory exists at ${worktreePath}, reusing`);
        // Update manifest
        manifest.worktrees[sanitized] = {
          ticketId,
          branchName,
          worktreePath,
          projectCwd: repoRoot,
          createdAt: Date.now(),
        };
        writeManifest(repoRoot, manifest);
        return { worktreePath, branchName };
      }

      // Ensure parent directory exists
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

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
      writeManifest(repoRoot, manifest);

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
      const manifest = getManifest(repoRoot);
      const entry = manifest.worktrees[sanitized];
      if (!entry) return;

      // Auto-commit if dirty
      if (fs.existsSync(entry.worktreePath)) {
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
      writeManifest(repoRoot, manifest);

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
    const manifest = getManifest(repoRoot);

    for (const [, entry] of Object.entries(manifest.worktrees)) {
      if (entry.projectCwd === repoRoot && fs.existsSync(entry.worktreePath)) {
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
    const manifest = getManifest(repoRoot);
    let changed = false;

    for (const [key, entry] of Object.entries(manifest.worktrees)) {
      if (!fs.existsSync(entry.worktreePath)) {
        debugLog(`worktree: pruning stale manifest entry for ${entry.ticketId}`);
        delete manifest.worktrees[key];
        changed = true;
      }
    }

    if (changed) {
      writeManifest(repoRoot, manifest);
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
