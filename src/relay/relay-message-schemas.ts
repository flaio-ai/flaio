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
  ticketId: z.string(),
  ticketTitle: z.string(),
  ticketDescription: z.string(),
  systemInstructions: z.array(z.string()),
  cwd: z.string().max(4096),
  driverName: z.string().optional(),
  previousPlan: z.string().optional(),
  feedback: z.string().optional(),
  iteration: z.number().int().optional(),
});

const RelayStartInteractivePlanningSchema = z.object({
  type: z.literal("relay_start_interactive_planning"),
  ticketId: z.string(),
  ticketTitle: z.string(),
  ticketDescription: z.string(),
  systemInstructions: z.array(z.string()),
  cwd: z.string().max(4096),
  driverName: z.string().optional(),
});

const RelayStartImplementationSchema = z.object({
  type: z.literal("relay_start_implementation"),
  ticketId: z.string(),
  plan: z.string(),
  systemInstructions: z.array(z.string()),
  cwd: z.string().max(4096),
  driverName: z.string().optional(),
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
]);
