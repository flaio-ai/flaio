// ---------------------------------------------------------------------------
// Ticket workspace (WS-A2)
//
// Durable context files kept in a ticket worktree under .flaio/ticket/:
//   brief.md      — context assembled by the platform for the current job
//   plan.md       — latest plan submitted by the agent
//   decisions.md  — append-only decision log
//   progress.md   — append-only progress log + handoff notes
//   questions.md  — questions asked by the agent and their answers
//
// Plus state.json (internal): ticket/job/phase bookkeeping used by the MCP
// tools and the Stop hook. The whole .flaio/ directory is kept out of commits
// via .git/info/exclude (see ensureExcluded).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { TICKET_WORKSPACE_DIR, TICKET_WORKSPACE_FILES } from "../contracts/mcp-tools.js";

export type TicketWorkspaceFile = keyof typeof TICKET_WORKSPACE_FILES;

/** Internal bookkeeping file, lives next to the markdown files. */
export const TICKET_WORKSPACE_STATE_FILE = "state.json";

/** Entry written to .git/info/exclude. */
export const WORKSPACE_EXCLUDE_ENTRY = ".flaio/";

export interface TicketWorkspaceState {
  ticketId?: string;
  jobId?: string | null;
  /** epoch ms — start of the current phase (set when a brief is written). */
  phaseStartedAt?: number;
  /** phaseStartedAt value of the phase in which the Stop hook already blocked once. */
  stopBlockedForPhase?: number;
}

export interface WorkspaceQuestion {
  questionId: string;
  text: string;
  blocking: boolean;
  status: "open" | "answered";
  answer: string | null;
}

export interface TicketWorkspaceSnapshot {
  brief: string | null;
  plan: string | null;
  decisions: string | null;
  progress: string | null;
  questions: string | null;
  parsedQuestions: WorkspaceQuestion[];
  openQuestions: { questionId: string; text: string }[];
  state: TicketWorkspaceState;
}

// ---- paths ----------------------------------------------------------------

export function workspaceDir(worktreePath: string): string {
  return path.join(worktreePath, TICKET_WORKSPACE_DIR);
}

export function workspaceFilePath(worktreePath: string, file: TicketWorkspaceFile): string {
  return path.join(workspaceDir(worktreePath), TICKET_WORKSPACE_FILES[file]);
}

export function workspaceStatePath(worktreePath: string): string {
  return path.join(workspaceDir(worktreePath), TICKET_WORKSPACE_STATE_FILE);
}

// ---- git exclude ----------------------------------------------------------

/**
 * Resolve the directory holding `info/exclude` for a working tree.
 * - Normal checkout: `<wt>/.git` is a directory → that directory.
 * - Linked worktree: `<wt>/.git` is a file `gitdir: <path>`; git reads
 *   info/exclude from the COMMON dir (`<gitdir>/commondir`), so resolve that.
 * Returns null when the path is not a git working tree.
 */
export async function resolveGitInfoDir(worktreePath: string): Promise<string | null> {
  const dotGit = path.join(worktreePath, ".git");
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;

  const content = (await fsp.readFile(dotGit, "utf-8")).trim();
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (!match) return null;
  const gitDir = path.resolve(worktreePath, match[1].trim());

  try {
    const common = (await fsp.readFile(path.join(gitDir, "commondir"), "utf-8")).trim();
    if (common) return path.resolve(gitDir, common);
  } catch {
    // No commondir (e.g. submodule gitdir) — gitdir itself is the repo dir.
  }
  return gitDir;
}

/**
 * Ensure `.flaio/` is listed in the repository's `info/exclude` so the ticket
 * workspace never ends up in a commit. Idempotent. Returns the exclude file
 * path, or null if `worktreePath` is not a git working tree.
 */
export async function ensureExcluded(worktreePath: string): Promise<string | null> {
  const infoParent = await resolveGitInfoDir(worktreePath);
  if (!infoParent) return null;

  const infoDir = path.join(infoParent, "info");
  const excludePath = path.join(infoDir, "exclude");
  await fsp.mkdir(infoDir, { recursive: true });

  let existing = "";
  try {
    existing = await fsp.readFile(excludePath, "utf-8");
  } catch {
    // Missing — create below.
  }

  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const covered = lines.some((l) => l === WORKSPACE_EXCLUDE_ENTRY || l === ".flaio" || l === "/.flaio/" || l === "/.flaio");
  if (covered) return excludePath;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fsp.appendFile(excludePath, `${prefix}# Flaio ticket workspace\n${WORKSPACE_EXCLUDE_ENTRY}\n`);
  return excludePath;
}

// ---- low-level helpers ----------------------------------------------------

/**
 * Symlink confinement. The worktree is a checkout of an arbitrary repository,
 * which may commit `.flaio`, `.flaio/ticket` or `.flaio/ticket/<file>` as
 * symlinks. Following them would let a repo make Flaio (running as the user,
 * outside the agent's permission mode) read or append to files anywhere, e.g.
 * `progress.md -> ~/.bashrc`. Every workspace path component below the
 * worktree must therefore be a real directory/file, never a symlink.
 */
export class WorkspacePathError extends Error {
  constructor(readonly target: string) {
    super(`Refusing to use Flaio ticket workspace path ${target}: it is a symlink`);
    this.name = "WorkspacePathError";
  }
}

function isSymlinkSync(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Throws WorkspacePathError if `.flaio`, `.flaio/ticket` or `filePath` (if given) is a symlink. */
function assertNoSymlinks(worktreePath: string, filePath?: string): void {
  const flaioDir = path.join(worktreePath, path.dirname(TICKET_WORKSPACE_DIR));
  for (const p of [flaioDir, workspaceDir(worktreePath), ...(filePath ? [filePath] : [])]) {
    if (isSymlinkSync(p)) throw new WorkspacePathError(p);
  }
}

/** Reads a workspace file; a missing or symlinked path reads as null. */
async function readWorkspaceFile(worktreePath: string, filePath: string): Promise<string | null> {
  try {
    assertNoSymlinks(worktreePath, filePath);
    return await fsp.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Create .flaio/ticket/ and make sure it's git-excluded. */
export async function ensureWorkspace(worktreePath: string): Promise<string> {
  const dir = workspaceDir(worktreePath);
  assertNoSymlinks(worktreePath);
  await fsp.mkdir(dir, { recursive: true });
  assertNoSymlinks(worktreePath);
  await ensureExcluded(worktreePath);
  return dir;
}

async function writeAtomic(worktreePath: string, filePath: string, content: string): Promise<void> {
  assertNoSymlinks(worktreePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  // "wx": never write through a pre-existing file/symlink at the tmp path.
  await fsp.writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
  // rename() replaces a symlink at filePath itself rather than following it.
  await fsp.rename(tmp, filePath);
}

const APPEND_NOFOLLOW =
  fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);

async function appendSection(worktreePath: string, file: TicketWorkspaceFile, title: string, section: string): Promise<void> {
  await ensureWorkspace(worktreePath);
  const filePath = workspaceFilePath(worktreePath, file);
  assertNoSymlinks(worktreePath, filePath);
  const existing = await readWorkspaceFile(worktreePath, filePath);
  const header = existing && existing.trim().length > 0 ? "" : `# ${title}\n`;
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  // O_NOFOLLOW closes the race between the lstat check and the open.
  await fsp.appendFile(filePath, `${sep}${header}\n${section.trimEnd()}\n`, { flag: APPEND_NOFOLLOW });
}

function timestamp(at: number): string {
  return new Date(at).toISOString();
}

// ---- state ----------------------------------------------------------------

export async function readWorkspaceState(worktreePath: string): Promise<TicketWorkspaceState> {
  const raw = await readWorkspaceFile(worktreePath, workspaceStatePath(worktreePath));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as TicketWorkspaceState) : {};
  } catch {
    return {};
  }
}

export async function updateWorkspaceState(
  worktreePath: string,
  patch: Partial<TicketWorkspaceState>,
): Promise<TicketWorkspaceState> {
  await ensureWorkspace(worktreePath);
  const next = { ...(await readWorkspaceState(worktreePath)), ...patch };
  await writeAtomic(worktreePath, workspaceStatePath(worktreePath), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/**
 * Mark the start of a new phase (job). The Stop hook uses phaseStartedAt to
 * decide whether progress.md was updated during this phase.
 */
export async function startPhase(
  worktreePath: string,
  phase: { ticketId?: string; jobId?: string | null; at?: number } = {},
): Promise<TicketWorkspaceState> {
  const patch: Partial<TicketWorkspaceState> = {
    phaseStartedAt: phase.at ?? Date.now(),
    stopBlockedForPhase: undefined,
  };
  if (phase.ticketId !== undefined) patch.ticketId = phase.ticketId;
  if (phase.jobId !== undefined) patch.jobId = phase.jobId;
  return updateWorkspaceState(worktreePath, patch);
}

// ---- public file ops ------------------------------------------------------

/**
 * Write the job brief (replaces brief.md) and start a new phase.
 * Called by WS-A1 before resuming/starting the agent for a job.
 */
export async function writeBrief(
  worktreePath: string,
  markdown: string,
  phase?: { ticketId?: string; jobId?: string | null },
): Promise<void> {
  await ensureWorkspace(worktreePath);
  await writeAtomic(worktreePath, workspaceFilePath(worktreePath, "brief"), markdown.endsWith("\n") ? markdown : markdown + "\n");
  await startPhase(worktreePath, phase ?? {});
}

/** Replace plan.md with the latest plan. */
export async function writePlan(worktreePath: string, markdown: string): Promise<void> {
  await ensureWorkspace(worktreePath);
  await writeAtomic(worktreePath, workspaceFilePath(worktreePath, "plan"), markdown.endsWith("\n") ? markdown : markdown + "\n");
}

export async function appendDecision(
  worktreePath: string,
  decision: { title: string; rationale: string },
  at: number = Date.now(),
): Promise<void> {
  await appendSection(
    worktreePath,
    "decisions",
    "Decisions",
    `## ${decision.title}\n_${timestamp(at)}_\n\n${decision.rationale.trim()}\n`,
  );
}

export type ProgressEntry =
  | string
  | { step: string; status: "started" | "done" | "skipped" | "failed"; note?: string };

/**
 * Append to progress.md. A string is appended as a free-form markdown note
 * (e.g. a handoff note); an object is formatted as a progress line.
 */
export async function appendProgress(worktreePath: string, entry: ProgressEntry, at: number = Date.now()): Promise<void> {
  const body =
    typeof entry === "string"
      ? `## Note — ${timestamp(at)}\n\n${entry.trim()}\n`
      : `- ${timestamp(at)} **${entry.status}** ${entry.step}${entry.note ? ` — ${entry.note.trim()}` : ""}`;
  await appendSection(worktreePath, "progress", "Progress", body);
}

// ---- questions --------------------------------------------------------------

const QUESTION_MARKER = /<!-- flaio:question id="([^"]+)" status="(open|answered)" blocking="(true|false)" -->/g;

export function parseQuestions(markdown: string | null): WorkspaceQuestion[] {
  if (!markdown) return [];
  const out: WorkspaceQuestion[] = [];
  const matches = [...markdown.matchAll(QUESTION_MARKER)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? markdown.length) : markdown.length;
    const block = markdown.slice(start, end);
    // Block layout: "\n## Question <id>\n\n<text>\n\n**Answer:** <answer>\n"
    const withoutHeading = block.replace(/^\s*## Question [^\n]*\n/, "");
    const answerIdx = withoutHeading.indexOf("\n**Answer:**");
    const text = (answerIdx >= 0 ? withoutHeading.slice(0, answerIdx) : withoutHeading).trim();
    const answer = answerIdx >= 0 ? withoutHeading.slice(answerIdx + "\n**Answer:**".length).trim() : null;
    out.push({
      questionId: m[1],
      status: m[2] as "open" | "answered",
      blocking: m[3] === "true",
      text,
      answer,
    });
  }
  return out;
}

function renderQuestions(questions: WorkspaceQuestion[]): string {
  const parts = ["# Questions\n"];
  for (const q of questions) {
    parts.push(
      `<!-- flaio:question id="${q.questionId}" status="${q.status}" blocking="${q.blocking}" -->\n` +
        `## Question ${q.questionId}${q.blocking ? " (blocking)" : ""}\n\n${q.text.trim()}\n` +
        (q.answer !== null ? `\n**Answer:** ${q.answer.trim()}\n` : ""),
    );
  }
  return parts.join("\n");
}

export async function recordQuestion(
  worktreePath: string,
  question: { questionId: string; text: string; blocking: boolean },
): Promise<void> {
  await ensureWorkspace(worktreePath);
  const filePath = workspaceFilePath(worktreePath, "questions");
  const questions = parseQuestions(await readWorkspaceFile(worktreePath, filePath)).filter((q) => q.questionId !== question.questionId);
  questions.push({ ...question, status: "open", answer: null });
  await writeAtomic(worktreePath, filePath, renderQuestions(questions));
}

/** Record a human answer. Returns false if the question id is unknown. */
export async function recordAnswer(worktreePath: string, questionId: string, answer: string): Promise<boolean> {
  await ensureWorkspace(worktreePath);
  const filePath = workspaceFilePath(worktreePath, "questions");
  const questions = parseQuestions(await readWorkspaceFile(worktreePath, filePath));
  const q = questions.find((x) => x.questionId === questionId);
  if (!q) return false;
  q.status = "answered";
  q.answer = answer;
  await writeAtomic(worktreePath, filePath, renderQuestions(questions));
  return true;
}

// ---- read -----------------------------------------------------------------

export async function readWorkspace(worktreePath: string): Promise<TicketWorkspaceSnapshot> {
  const [brief, plan, decisions, progress, questions, state] = await Promise.all([
    readWorkspaceFile(worktreePath, workspaceFilePath(worktreePath, "brief")),
    readWorkspaceFile(worktreePath, workspaceFilePath(worktreePath, "plan")),
    readWorkspaceFile(worktreePath, workspaceFilePath(worktreePath, "decisions")),
    readWorkspaceFile(worktreePath, workspaceFilePath(worktreePath, "progress")),
    readWorkspaceFile(worktreePath, workspaceFilePath(worktreePath, "questions")),
    readWorkspaceState(worktreePath),
  ]);
  const parsedQuestions = parseQuestions(questions);
  return {
    brief,
    plan,
    decisions,
    progress,
    questions,
    parsedQuestions,
    openQuestions: parsedQuestions
      .filter((q) => q.status === "open")
      .map((q) => ({ questionId: q.questionId, text: q.text })),
    state,
  };
}

/** mtime (epoch ms) of a workspace file, or null when it doesn't exist. */
export function workspaceFileMtimeSync(worktreePath: string, file: TicketWorkspaceFile): number | null {
  try {
    const filePath = workspaceFilePath(worktreePath, file);
    assertNoSymlinks(worktreePath, filePath);
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}
