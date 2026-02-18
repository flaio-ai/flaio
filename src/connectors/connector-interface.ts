export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

export interface PermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
}

export interface PermissionReply {
  allowed: boolean;
  message?: string;
}

export interface ToolResult {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: string;
}

export interface SessionNotification {
  sessionId: string;
  type: "started" | "stopped" | "waiting_input" | "error" | "response";
  message: string;
  cwd?: string;
}

export interface IConnector {
  readonly name: string;
  readonly displayName: string;
  readonly status: ConnectorStatus;

  /** Initialize and connect to the service */
  connect(): Promise<void>;

  /** Cleanly disconnect */
  disconnect(): Promise<void>;

  /** Send a permission request and wait for a reply */
  requestPermission(request: PermissionRequest): Promise<PermissionReply>;

  /** Post a tool result (fire and forget) */
  postToolResult(result: ToolResult): Promise<void>;

  /** Post a session notification (fire and forget) */
  postNotification(notification: SessionNotification): Promise<void>;

  /** Register a handler for incoming prompts from the messaging platform */
  onPrompt(handler: (prompt: string, sessionId?: string) => void): void;
}
