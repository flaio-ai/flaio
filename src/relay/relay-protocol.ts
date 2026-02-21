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
}

export interface CliPongMsg {
  type: "cli_pong";
}

export type CliToRelayMsg =
  | CliAuthMsg
  | CliRegisterSessionMsg
  | CliUnregisterSessionMsg
  | CliPtyDataMsg
  | CliSessionStatusMsg
  | CliPongMsg;

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

export type BrowserToRelayMsg =
  | WebAuthMsg
  | WebListSessionsMsg
  | WebSubscribeMsg
  | WebUnsubscribeMsg
  | WebInputMsg
  | WebResizeMsg
  | WebCreateSessionMsg
  | WebPongMsg;

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

export type RelayToCliMsg =
  | RelayAuthOkMsg
  | RelayAuthFailMsg
  | RelayInputMsg
  | RelayResizeMsg
  | RelayViewerJoinedMsg
  | RelayViewerLeftMsg
  | RelayCreateSessionMsg
  | RelayPingMsg;

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

export type RelayToBrowserMsg =
  | RelayWebAuthOkMsg
  | RelayWebAuthFailMsg
  | RelaySessionsMsg
  | RelayPtyDataMsg
  | RelaySessionStatusMsg
  | RelaySessionEndedMsg
  | RelaySessionCreatedMsg
  | RelayWebPingMsg;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RELAY_URL = "wss://relay.agentmanager.dev";
export const AUTH_URL = "https://app.agentmanager.dev/auth/cli";

/** Heartbeat interval in ms */
export const PING_INTERVAL_MS = 30_000;
/** Dead connection timeout in ms */
export const PONG_TIMEOUT_MS = 15_000;
