// Public surface of the Flaio MCP module (WS-A2).
// NOTE: does not re-export ./server.js so importing spawn config in the CLI
// does not pull in the MCP SDK.
export {
  getMcpSpawnConfig,
  disposeMcpSpawnConfig,
  buildMcpConfigJson,
  buildStopHookSettingsJson,
  type McpSpawnConfig,
  type McpSpawnOptions,
} from "./spawn-config.js";
export {
  registerMcpSession,
  resolveMcpSession,
  updateMcpSession,
  revokeMcpSession,
  revokeMcpSessionsForTicket,
  type McpSessionBinding,
} from "./session-registry.js";
export { handleMcpToolCall, type McpToolCallPayload, type McpToolCallResult } from "./bridge.js";
export { handleToolCall, ToolInputError, type ToolContext, type ToolDeps } from "./tool-handlers.js";
