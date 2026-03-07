// ---------------------------------------------------------------------------
// WebSocket protocol message types for CLI ↔ Relay ↔ Browser communication
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export type ShareMode = "read-only" | "read-write";

export interface RelaySessionInfo {
  sessionId: string;
  driverName: string;
  displayName: string;
  cwd: string;
  status: string;
  cols: number;
  rows: number;
  /** Whether this session is interactive (TUI) or non-interactive (print mode) */
  interactive?: boolean;
  /** The CLI command string that was used to spawn this session */
  command?: string;
  /** Detailed state from sideband hooks */
  detailedState?: string;
  /** Detailed sub-state */
  detailedDetail?: string;
  /** Current tool name */
  currentTool?: string;
  /** Model display name from status line */
  modelDisplayName?: string;
  /** Cumulative cost USD */
  totalCostUsd?: number;
  /** Context window usage percentage */
  usedPercentage?: number;
  /** Lines added this session */
  totalLinesAdded?: number;
  /** Lines removed this session */
  totalLinesRemoved?: number;
  /** Whether cost display is enabled (CLI setting) */
  showCost?: boolean;
}

// ---------------------------------------------------------------------------
// CLI → Relay messages
// ---------------------------------------------------------------------------

export interface CliAuthMsg {
  type: "cli_auth";
  token: string;
}

export interface CliRegisterSessionMsg {
  type: "cli_register_session";
  sessionId: string;
  driverName: string;
  displayName: string;
  cwd: string;
  status: string;
  cols: number;
  rows: number;
  /** Base64-encoded ECDH P-256 public key (present when E2E is enabled) */
  publicKey?: string;
  /** Whether this session is interactive (TUI) or non-interactive (print mode) */
  interactive?: boolean;
  /** The CLI command string that was used to spawn this session */
  command?: string;
}

export interface CliUnregisterSessionMsg {
  type: "cli_unregister_session";
  sessionId: string;
}

export interface CliPtyDataMsg {
  type: "cli_pty_data";
  sessionId: string;
  /** Base64-encoded raw PTY output */
  data: string;
}

export interface CliSessionStatusMsg {
  type: "cli_session_status";
  sessionId: string;
  status: string;
  /** Detailed state from sideband hooks (e.g. "running", "waiting_input") */
  detailedState?: string;
  /** Detailed sub-state (e.g. "tool_use", "thinking", "prompt") */
  detailedDetail?: string;
  /** Current tool name if a tool is in use */
  currentTool?: string;
}

export interface CliSessionMetadataMsg {
  type: "cli_session_metadata";
  sessionId: string;
  modelId?: string;
  modelDisplayName?: string;
  totalCostUsd?: number;
  totalDurationMs?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  usedPercentage?: number;
  contextTotalTokens?: number;
  contextUsedTokens?: number;
  /** Whether cost display is enabled (CLI setting) */
  showCost?: boolean;
}

export interface CliPongMsg {
  type: "cli_pong";
}

export interface CliSessionPublicKeyMsg {
  type: "cli_session_public_key";
  sessionId: string;
  /** Base64-encoded ECDH P-256 public key */
  publicKey: string;
}

export interface CliWrappedKeyMsg {
  type: "cli_wrapped_key";
  sessionId: string;
  viewerId: string;
  /** Encrypted SCK (wire format: base64(nonce || ciphertext || tag)) */
  wrappedKey: string;
  /** Base64-encoded HKDF salt used for KEK derivation */
  salt: string;
}

export interface CliEncryptedPtyDataMsg {
  type: "cli_encrypted_pty_data";
  sessionId: string;
  /** Encrypted PTY output (wire format: base64(nonce || ciphertext || tag)) */
  data: string;
  /** Monotonic sequence number for ordering */
  seq: number;
}

export interface CliBrowseDirResultMsg {
  type: "cli_browse_dir_result";
  requestId: string;
  viewerId: string;
  resolvedPath: string;
  directories: string[];
  error: string | null;
}

export interface CliBrowseFilesResultMsg {
  type: "cli_browse_files_result";
  requestId: string;
  viewerId: string;
  resolvedPath: string;
  directories: string[];
  files: string[];
  error: string | null;
}

// Phase 3: Ticket lifecycle messages (CLI -> Relay)

export interface CliPlanReadyMsg {
  type: "cli_plan_ready";
  ticketId: string;
  sessionId: string;
  plan: string;
  iteration: number;
  feedback: string | null;
  branchName?: string;
}

export interface CliImplementationDoneMsg {
  type: "cli_implementation_done";
  ticketId: string;
  sessionId: string;
  summary: string;
  gitContext: { branch?: string; prUrl?: string };
}

export interface CliTicketStatusMsg {
  type: "cli_ticket_status";
  ticketId: string;
  sessionId: string;
  status: "planning" | "plan_ready" | "implementing" | "done" | "error";
  message?: string;
  branchName?: string;
}

export interface CliGitInfoResultMsg {
  type: "cli_git_info_result";
  requestId: string;
  viewerId: string;
  branch: string | null;
  remoteUrl: string | null;
  commits: { hash: string; message: string; author: string; timestamp: number }[];
  changedFiles: number;
  isClean: boolean;
  error: string | null;
}

export interface ModelInfo {
  id: string;
  displayName: string;
}

export interface DriverInfo {
  name: string;
  displayName: string;
  installed: boolean;
  models: ModelInfo[];
}

export interface CliDriversResultMsg {
  type: "cli_drivers_result";
  viewerId: string;
  drivers: DriverInfo[];
}

/** Default driver name used when none is specified in relay messages */
export const DEFAULT_DRIVER_NAME = "claude";

export interface CliSetUserSettingsMsg {
  type: "cli_set_user_settings";
  worktreeDefaults?: Partial<{ planning: boolean; interactivePlanning: boolean; implementation: boolean }>;
}

export type CliToRelayMsg =
  | CliAuthMsg
  | CliRegisterSessionMsg
  | CliUnregisterSessionMsg
  | CliPtyDataMsg
  | CliSessionStatusMsg
  | CliSessionMetadataMsg
  | CliPongMsg
  | CliSessionPublicKeyMsg
  | CliWrappedKeyMsg
  | CliEncryptedPtyDataMsg
  | CliBrowseDirResultMsg
  | CliBrowseFilesResultMsg
  | CliPlanReadyMsg
  | CliImplementationDoneMsg
  | CliTicketStatusMsg
  | CliGitInfoResultMsg
  | CliDriversResultMsg
  | CliSetUserSettingsMsg;

// ---------------------------------------------------------------------------
// Browser → Relay messages
// ---------------------------------------------------------------------------

export interface WebAuthMsg {
  type: "web_auth";
  token: string;
}

export interface WebListSessionsMsg {
  type: "web_list_sessions";
}

export interface WebSubscribeMsg {
  type: "web_subscribe";
  sessionId: string;
  mode: ShareMode;
}

export interface WebUnsubscribeMsg {
  type: "web_unsubscribe";
}

export interface WebInputMsg {
  type: "web_input";
  sessionId: string;
  /** Base64-encoded keystrokes */
  data: string;
}

export interface WebResizeMsg {
  type: "web_resize";
  sessionId: string;
  cols: number;
  rows: number;
}

export interface WebCreateSessionMsg {
  type: "web_create_session";
  driverName: string;
  cwd: string;
}

export interface WebPongMsg {
  type: "web_pong";
}

export interface WebViewerPublicKeyMsg {
  type: "web_viewer_public_key";
  sessionId: string;
  viewerId: string;
  /** Base64-encoded ECDH P-256 public key */
  publicKey: string;
}

export interface WebEncryptedInputMsg {
  type: "web_encrypted_input";
  sessionId: string;
  viewerId: string;
  /** Encrypted keystrokes (wire format: base64(nonce || ciphertext || tag)) */
  data: string;
}

export interface WebBrowseDirMsg {
  type: "web_browse_dir";
  requestId: string;
  path: string;
}

export type BrowserToRelayMsg =
  | WebAuthMsg
  | WebListSessionsMsg
  | WebSubscribeMsg
  | WebUnsubscribeMsg
  | WebInputMsg
  | WebResizeMsg
  | WebCreateSessionMsg
  | WebPongMsg
  | WebViewerPublicKeyMsg
  | WebEncryptedInputMsg
  | WebBrowseDirMsg;

// ---------------------------------------------------------------------------
// Relay → CLI messages
// ---------------------------------------------------------------------------

export interface RelayAuthOkMsg {
  type: "relay_auth_ok";
}

export interface RelayAuthFailMsg {
  type: "relay_auth_fail";
  reason: string;
}

export interface RelayInputMsg {
  type: "relay_input";
  sessionId: string;
  /** Base64-encoded keystrokes from browser */
  data: string;
  viewerId: string;
}

export interface RelayResizeMsg {
  type: "relay_resize";
  sessionId: string;
  cols: number;
  rows: number;
}

export interface RelayViewerJoinedMsg {
  type: "relay_viewer_joined";
  sessionId: string;
  viewerId: string;
}

export interface RelayViewerLeftMsg {
  type: "relay_viewer_left";
  sessionId: string;
  viewerId: string;
}

export interface RelayCreateSessionMsg {
  type: "relay_create_session";
  driverName: string;
  cwd: string;
}

export interface RelayPingMsg {
  type: "relay_ping";
}

export interface RelayViewerPublicKeyMsg {
  type: "relay_viewer_public_key";
  sessionId: string;
  viewerId: string;
  /** Base64-encoded ECDH P-256 public key from viewer */
  publicKey: string;
}

export interface RelayEncryptedInputMsg {
  type: "relay_encrypted_input";
  sessionId: string;
  viewerId: string;
  /** Encrypted keystrokes from viewer (wire format: base64(nonce || ciphertext || tag)) */
  data: string;
}

export interface RelayBrowseDirMsg {
  type: "relay_browse_dir";
  requestId: string;
  viewerId: string;
  path: string;
}

export interface RelayBrowseFilesMsg {
  type: "relay_browse_files";
  requestId: string;
  viewerId: string;
  path: string;
}

export interface RelayListDriversMsg {
  type: "relay_list_drivers";
  viewerId: string;
}

// Phase 3: Ticket lifecycle messages (Relay -> CLI)

export interface RelayStartPlanningMsg {
  type: "relay_start_planning";
  sessionId?: string;
  ticketId: string;
  ticketTitle: string;
  ticketDescription: string;
  systemInstructions: string[];
  cwd: string;
  driverName?: string;
  model?: string;
  previousPlan?: string;
  feedback?: string;
  iteration?: number;
  useWorktree?: boolean;
}

export interface RelayStartInteractivePlanningMsg {
  type: "relay_start_interactive_planning";
  sessionId?: string;
  ticketId: string;
  ticketTitle: string;
  ticketDescription: string;
  systemInstructions: string[];
  cwd: string;
  driverName?: string;
  model?: string;
  useWorktree?: boolean;
}

export interface RelayStartImplementationMsg {
  type: "relay_start_implementation";
  sessionId?: string;
  ticketId: string;
  plan: string;
  systemInstructions: string[];
  cwd: string;
  driverName?: string;
  model?: string;
  useWorktree?: boolean;
}

export interface RelayRequestChangesMsg {
  type: "relay_request_changes";
  ticketId: string;
  sessionId: string;
  feedback: string;
}

export interface RelayCloseSessionMsg {
  type: "relay_close_session";
  sessionId: string;
}

export interface RelayRequestGitInfoMsg {
  type: "relay_request_git_info";
  requestId: string;
  viewerId: string;
  cwd: string;
}

export interface RelayRepoDetectedMsg {
  type: "relay_repo_detected";
  sessionId: string;
  orgId: string;
  orgName: string;
  repoId: string;
  repoName: string;
  repoFullName: string;
  settings: {
    agent?: string | null;
    model?: string | null;
    worktree?: boolean;
    systemInstructions?: Array<{ label: string; content: string }>;
  };
  enforced: {
    agent?: boolean;
    model?: boolean;
    worktree?: boolean;
  };
}

export interface RelayUserSettingsMsg {
  type: "relay_user_settings";
  worktreeDefaults: { planning: boolean; interactivePlanning: boolean; implementation: boolean };
}

export type RelayToCliMsg =
  | RelayAuthOkMsg
  | RelayAuthFailMsg
  | RelayInputMsg
  | RelayResizeMsg
  | RelayViewerJoinedMsg
  | RelayViewerLeftMsg
  | RelayCreateSessionMsg
  | RelayPingMsg
  | RelayViewerPublicKeyMsg
  | RelayEncryptedInputMsg
  | RelayBrowseDirMsg
  | RelayBrowseFilesMsg
  | RelayStartPlanningMsg
  | RelayStartInteractivePlanningMsg
  | RelayStartImplementationMsg
  | RelayRequestChangesMsg
  | RelayCloseSessionMsg
  | RelayRequestGitInfoMsg
  | RelayListDriversMsg
  | RelayRepoDetectedMsg
  | RelayUserSettingsMsg;

// ---------------------------------------------------------------------------
// Relay → Browser messages
// ---------------------------------------------------------------------------

export interface RelayWebAuthOkMsg {
  type: "relay_web_auth_ok";
}

export interface RelayWebAuthFailMsg {
  type: "relay_web_auth_fail";
  reason: string;
}

export interface RelaySessionsMsg {
  type: "relay_sessions";
  sessions: RelaySessionInfo[];
}

export interface RelayPtyDataMsg {
  type: "relay_pty_data";
  sessionId: string;
  /** Base64-encoded raw PTY output (forwarded from CLI) */
  data: string;
}

export interface RelaySessionStatusMsg {
  type: "relay_session_status";
  sessionId: string;
  status: string;
  /** Detailed state from sideband hooks */
  detailedState?: string;
  /** Detailed sub-state */
  detailedDetail?: string;
  /** Current tool name */
  currentTool?: string;
}

export interface RelaySessionMetadataMsg {
  type: "relay_session_metadata";
  sessionId: string;
  modelId?: string;
  modelDisplayName?: string;
  totalCostUsd?: number;
  totalDurationMs?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  usedPercentage?: number;
  contextTotalTokens?: number;
  contextUsedTokens?: number;
}

export interface RelaySessionEndedMsg {
  type: "relay_session_ended";
  sessionId: string;
}

export interface RelaySessionCreatedMsg {
  type: "relay_session_created";
  sessionId: string;
}

export interface RelayWebPingMsg {
  type: "relay_ping";
}

export interface RelaySessionPublicKeyMsg {
  type: "relay_session_public_key";
  sessionId: string;
  /** Base64-encoded ECDH P-256 public key from CLI */
  publicKey: string;
}

export interface RelayWrappedKeyMsg {
  type: "relay_wrapped_key";
  sessionId: string;
  viewerId: string;
  /** Encrypted SCK (wire format: base64(nonce || ciphertext || tag)) */
  wrappedKey: string;
  /** Base64-encoded HKDF salt used for KEK derivation */
  salt: string;
}

export interface RelayEncryptedPtyDataMsg {
  type: "relay_encrypted_pty_data";
  sessionId: string;
  /** Encrypted PTY output (wire format: base64(nonce || ciphertext || tag)) */
  data: string;
  /** Monotonic sequence number for ordering */
  seq: number;
}

export interface RelayBrowseDirResultMsg {
  type: "relay_browse_dir_result";
  requestId: string;
  resolvedPath: string;
  directories: string[];
  error: string | null;
}

export type RelayToBrowserMsg =
  | RelayWebAuthOkMsg
  | RelayWebAuthFailMsg
  | RelaySessionsMsg
  | RelayPtyDataMsg
  | RelaySessionStatusMsg
  | RelaySessionMetadataMsg
  | RelaySessionEndedMsg
  | RelaySessionCreatedMsg
  | RelayWebPingMsg
  | RelaySessionPublicKeyMsg
  | RelayWrappedKeyMsg
  | RelayEncryptedPtyDataMsg
  | RelayBrowseDirResultMsg;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RELAY_URL = "wss://api.flaio.ai";
export const AUTH_URL = "https://flaio.ai/auth/cli";

/** Heartbeat interval in ms */
export const PING_INTERVAL_MS = 30_000;
/** Dead connection timeout in ms */
export const PONG_TIMEOUT_MS = 15_000;
