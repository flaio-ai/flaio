import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas for runtime validation of Relay → CLI messages.
// Mirrors the TypeScript interfaces in relay-protocol.ts.
// ---------------------------------------------------------------------------

const RelayAuthOkSchema = z.object({
  type: z.literal("relay_auth_ok"),
});

const RelayAuthFailSchema = z.object({
  type: z.literal("relay_auth_fail"),
  reason: z.string(),
});

const RelayInputSchema = z.object({
  type: z.literal("relay_input"),
  sessionId: z.string(),
  data: z.string(),
  viewerId: z.string(),
});

const RelayResizeSchema = z.object({
  type: z.literal("relay_resize"),
  sessionId: z.string(),
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(500),
});

const RelayViewerJoinedSchema = z.object({
  type: z.literal("relay_viewer_joined"),
  sessionId: z.string(),
  viewerId: z.string(),
});

const RelayViewerLeftSchema = z.object({
  type: z.literal("relay_viewer_left"),
  sessionId: z.string(),
  viewerId: z.string(),
});

const RelayCreateSessionSchema = z.object({
  type: z.literal("relay_create_session"),
  driverName: z.string().max(64),
  cwd: z.string().max(4096),
});

const RelayPingSchema = z.object({
  type: z.literal("relay_ping"),
});

const RelayViewerPublicKeySchema = z.object({
  type: z.literal("relay_viewer_public_key"),
  sessionId: z.string(),
  viewerId: z.string(),
  publicKey: z.string(),
});

const RelayEncryptedInputSchema = z.object({
  type: z.literal("relay_encrypted_input"),
  sessionId: z.string(),
  viewerId: z.string(),
  data: z.string(),
});

const RelayBrowseDirSchema = z.object({
  type: z.literal("relay_browse_dir"),
  requestId: z.string(),
  viewerId: z.string(),
  path: z.string().max(4096),
});

const RelayBrowseFilesSchema = z.object({
  type: z.literal("relay_browse_files"),
  requestId: z.string(),
  viewerId: z.string(),
  path: z.string().max(4096),
});

const RelayStartPlanningSchema = z.object({
  type: z.literal("relay_start_planning"),
  sessionId: z.string().optional(),
  ticketId: z.string(),
  ticketTitle: z.string(),
  ticketDescription: z.string(),
  systemInstructions: z.array(z.string()),
  cwd: z.string().max(4096),
  driverName: z.string().optional(),
  model: z.string().optional(),
  previousPlan: z.string().optional(),
  feedback: z.string().optional(),
  iteration: z.number().int().optional(),
  useWorktree: z.boolean().optional(),
});

const RelayStartInteractivePlanningSchema = z.object({
  type: z.literal("relay_start_interactive_planning"),
  sessionId: z.string().optional(),
  ticketId: z.string(),
  ticketTitle: z.string(),
  ticketDescription: z.string(),
  systemInstructions: z.array(z.string()),
  cwd: z.string().max(4096),
  driverName: z.string().optional(),
  model: z.string().optional(),
  useWorktree: z.boolean().optional(),
});

const RelayStartImplementationSchema = z.object({
  type: z.literal("relay_start_implementation"),
  sessionId: z.string().optional(),
  ticketId: z.string(),
  plan: z.string(),
  systemInstructions: z.array(z.string()),
  cwd: z.string().max(4096),
  driverName: z.string().optional(),
  model: z.string().optional(),
  useWorktree: z.boolean().optional(),
});

const RelayRequestChangesSchema = z.object({
  type: z.literal("relay_request_changes"),
  ticketId: z.string(),
  sessionId: z.string(),
  feedback: z.string(),
});

const RelayCloseSessionSchema = z.object({
  type: z.literal("relay_close_session"),
  sessionId: z.string(),
});

const RelayRequestGitInfoSchema = z.object({
  type: z.literal("relay_request_git_info"),
  requestId: z.string(),
  viewerId: z.string(),
  cwd: z.string().max(4096),
});

const RelayListDriversSchema = z.object({
  type: z.literal("relay_list_drivers"),
  viewerId: z.string(),
});

const RelayRepoDetectedSchema = z.object({
  type: z.literal("relay_repo_detected"),
  sessionId: z.string(),
  orgId: z.string(),
  orgName: z.string(),
  repoId: z.string(),
  repoName: z.string(),
  repoFullName: z.string(),
  settings: z.object({
    agent: z.string().nullish(),
    model: z.string().nullish(),
    worktree: z.boolean().optional(),
    systemInstructions: z.array(z.object({
      label: z.string(),
      content: z.string(),
    })).optional(),
  }),
  enforced: z.object({
    agent: z.boolean().optional(),
    model: z.boolean().optional(),
    worktree: z.boolean().optional(),
  }),
});

const RelayUserSettingsSchema = z.object({
  type: z.literal("relay_user_settings"),
  worktreeDefaults: z.object({
    planning: z.boolean(),
    interactivePlanning: z.boolean(),
    implementation: z.boolean(),
  }),
});

// Virtual developer (Stage 0): job dispatch. Mirrors RelayRunJobMsg / RelayCancelJobMsg.

const JobKindSchema = z.enum([
  "plan",
  "implement",
  "revise_plan",
  "review_fixes",
  "ci_fix",
  "answer_resume",
  "pr_review",
  "pr_fix",
]);

// Pull requests (Wave 0). Mirrors PrJobSubject / PrFixInput in contracts/agent-loop.ts.
const PrJobSubjectSchema = z.object({
  type: z.literal("pr"),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  headSha: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  isFork: z.boolean(),
});

const PrFixInputSchema = z.object({
  findingIds: z.array(z.string()),
  target: z.enum(["same_branch", "new_branch"]),
  newBranchName: z.string().optional(),
  maintainerCanModify: z.boolean().optional(),
  headRepository: z.string().max(200).optional(),
});

const TicketAgentSessionSchema = z.object({
  id: z.string(),
  driver: z.string(),
  transcriptPath: z.string().optional(),
  runnerId: z.string().optional(),
  resumeCount: z.number().int(),
  lastResumedAt: z.number().optional(),
});

const JobSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  ownerUid: z.string(),
  orgId: z.string().nullable(),
  kind: JobKindSchema,
  prompt: z.string().nullable(),
  permissionMode: z.enum(["plan", "acceptEdits", "default"]),
  status: z.enum(["queued", "claimed", "running", "done", "failed", "cancelled"]),
  runnerId: z.string().nullable(),
  leaseExpiresAt: z.number().nullable(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  availableAt: z.number().nullable().optional(),
  runOptions: z
    .object({
      cwd: z.string().optional(),
      driverName: z.string().optional(),
      model: z.string().optional(),
      useWorktree: z.boolean().optional(),
      systemInstructions: z.array(z.string()).optional(),
      teamId: z.string().nullable().optional(),
      sessionId: z.string().optional(),
      iteration: z.number().optional(),
      runnerPreference: z.enum(["auto", "local", "cloud"]).optional(),
    })
    .nullable()
    .optional(),
  result: z.enum(["success", "needs_info", "failed"]).nullable().optional(),
  subject: PrJobSubjectSchema.nullable().optional(),
  reviewId: z.string().nullable().optional(),
  fix: PrFixInputSchema.nullable().optional(),
});

const RelayRunJobSchema = z.object({
  type: z.literal("relay_run_job"),
  job: JobSchema,
  ticket: z.object({
    id: z.string(),
    title: z.string(),
    cwd: z.string().max(4096),
    useWorktree: z.boolean(),
    driverName: z.string(),
    model: z.string().nullable(),
    agentSession: TicketAgentSessionSchema.nullable(),
  }),
  briefMarkdown: z.string().max(512 * 1024),
  systemInstructions: z.array(z.string()),
});

const RelayCancelJobSchema = z.object({
  type: z.literal("relay_cancel_job"),
  jobId: z.string(),
  ticketId: z.string(),
  reason: z.string(),
});

export const RelayToCliMsgSchema = z.discriminatedUnion("type", [
  RelayAuthOkSchema,
  RelayAuthFailSchema,
  RelayInputSchema,
  RelayResizeSchema,
  RelayViewerJoinedSchema,
  RelayViewerLeftSchema,
  RelayCreateSessionSchema,
  RelayPingSchema,
  RelayViewerPublicKeySchema,
  RelayEncryptedInputSchema,
  RelayBrowseDirSchema,
  RelayBrowseFilesSchema,
  RelayStartPlanningSchema,
  RelayStartInteractivePlanningSchema,
  RelayStartImplementationSchema,
  RelayRequestChangesSchema,
  RelayCloseSessionSchema,
  RelayRequestGitInfoSchema,
  RelayListDriversSchema,
  RelayRepoDetectedSchema,
  RelayUserSettingsSchema,
  RelayRunJobSchema,
  RelayCancelJobSchema,
]);
