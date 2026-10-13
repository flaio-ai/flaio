#!/usr/bin/env node

/**
 * Stop hook for Claude Code.
 *
 * 1. Ticket handoff guard (WS-A2): when the session belongs to a Flaio ticket
 *    job (env FLAIO_TICKET_ID) and .flaio/ticket/progress.md was not updated
 *    during the current phase, block the stop ONCE with an instruction to write
 *    the handoff note. Uses Claude Code's Stop decision control: print
 *    `{"decision":"block","reason":"..."}` on stdout and exit 0. Never blocks
 *    when `stop_hook_active` is true (Claude is already continuing because of a
 *    Stop hook) and never more than once per phase.
 * 2. Notifies flaio via IPC that the session stopped (best effort).
 *
 * stdin: JSON with session_id, cwd, stop_hook_active, ...
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendToHookServer } from "./hook-server.js";
import {
  readWorkspaceState,
  updateWorkspaceState,
  workspaceDir,
  workspaceFileMtimeSync,
} from "../workspace/ticket-workspace.js";

export interface StopHookInput {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

export type StopDecision =
  | { block: false; reason: "not_ticket" | "stop_hook_active" | "no_workspace" | "progress_updated" | "already_blocked" }
  | { block: true; reason: string };

export const HANDOFF_INSTRUCTION =
  "Before stopping, write the Flaio handoff note: append to .flaio/ticket/progress.md (in the ticket worktree) " +
  "a short section covering what you did this phase, the current state of the branch (what works, what is " +
  "unfinished), anything you tried that failed, and the exact next steps for whoever resumes this ticket. " +
  "If the phase is finished, also call the flaio complete_phase tool. Then stop.";

/** Resolve the ticket worktree for this hook invocation. */
export function resolveTicketWorktree(input: StopHookInput, env: NodeJS.ProcessEnv): string | null {
  return env.FLAIO_TICKET_WORKTREE || input.cwd || env.CLAUDE_PROJECT_DIR || null;
}

/**
 * Decide whether to block. Records the block in .flaio/ticket/state.json so a
 * phase is blocked at most once even if stop_hook_active is missing.
 */
export async function decideStop(input: StopHookInput, env: NodeJS.ProcessEnv = process.env): Promise<StopDecision> {
  if (!env.FLAIO_TICKET_ID) return { block: false, reason: "not_ticket" };
  if (input.stop_hook_active === true) return { block: false, reason: "stop_hook_active" };

  const worktree = resolveTicketWorktree(input, env);
  if (!worktree || !fs.existsSync(workspaceDir(worktree))) return { block: false, reason: "no_workspace" };

  const state = await readWorkspaceState(worktree);
  const phaseStartedAt = state.phaseStartedAt ?? workspaceFileMtimeSync(worktree, "brief") ?? 0;

  const progressMtime = workspaceFileMtimeSync(worktree, "progress");
  if (progressMtime !== null && progressMtime >= phaseStartedAt) return { block: false, reason: "progress_updated" };

  if (state.stopBlockedForPhase === phaseStartedAt) return { block: false, reason: "already_blocked" };

  await updateWorkspaceState(worktree, { stopBlockedForPhase: phaseStartedAt });
  return { block: true, reason: HANDOFF_INSTRUCTION };
}

/** Run the hook on raw stdin; returns the stdout JSON to print, or null. */
export async function runStopHook(rawStdin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  let data: StopHookInput;
  try {
    data = JSON.parse(rawStdin) as StopHookInput;
  } catch {
    return null;
  }

  let output: string | null = null;
  try {
    const decision = await decideStop(data, env);
    if (decision.block) output = JSON.stringify({ decision: "block", reason: decision.reason });
  } catch {
    // Never break the session because of the guard.
  }

  await sendToHookServer(
    { type: "stop", payload: { sessionId: data.session_id, cwd: data.cwd, exitCode: data.exit_code } },
    2000,
  ).catch(() => null);

  return output;
}

async function main(): Promise<void> {
  let input: string;
  try {
    input = fs.readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
    return;
  }
  const output = await runStopHook(input);
  if (output) fs.writeSync(1, output);
  process.exit(0);
}

function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url)).replace(/\.[^.]+$/, "");
    const invoked = fs.realpathSync(path.resolve(argv1)).replace(/\.[^.]+$/, "");
    return self === invoked;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(() => {
    process.exit(0);
  });
}
