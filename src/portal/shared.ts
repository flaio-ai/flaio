import path from "node:path";
import os from "node:os";
import type { ScreenContent } from "../terminal/screen-buffer.js";

export const PORTAL_SOCKET_DIR = path.join(os.tmpdir(), "agent-manager");
export const PORTAL_SOCKET_PATH = path.join(PORTAL_SOCKET_DIR, "portal.sock");

// ---------------------------------------------------------------------------
// Session info sent in list responses
// ---------------------------------------------------------------------------

export interface PortalSessionInfo {
  id: string;
  driverName: string;
  displayName: string;
  cwd: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export interface PortalListMsg {
  type: "portal_list";
}

export interface PortalSubscribeMsg {
  type: "portal_subscribe";
  sessionId: string;
}

export interface PortalInputMsg {
  type: "portal_input";
  data: string;
}

export interface PortalUnsubscribeMsg {
  type: "portal_unsubscribe";
}

export type PortalClientMsg =
  | PortalListMsg
  | PortalSubscribeMsg
  | PortalInputMsg
  | PortalUnsubscribeMsg;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export interface PortalSessionsMsg {
  type: "portal_sessions";
  sessions: PortalSessionInfo[];
}

export interface PortalFrameMsg {
  type: "portal_frame";
  content: ScreenContent;
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
}

export interface PortalStatusMsg {
  type: "portal_status";
  sessionId: string;
  status: string;
}

export interface PortalSessionEndedMsg {
  type: "portal_session_ended";
  sessionId: string;
}

export interface PortalErrorMsg {
  type: "portal_error";
  message: string;
}

export type PortalServerMsg =
  | PortalSessionsMsg
  | PortalFrameMsg
  | PortalStatusMsg
  | PortalSessionEndedMsg
  | PortalErrorMsg;
