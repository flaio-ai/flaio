// ---------------------------------------------------------------------------
// DetailedStatus type + pure resolver functions
// ---------------------------------------------------------------------------

import type { AgentStatus } from "../drivers/base-driver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetailedStatus =
  | { state: "running"; detail: "thinking" | "tool_use" | "writing" | "subagent" | "compacting" | "general" }
  | { state: "waiting_input"; detail: "prompt" | "idle_timeout" | "ask_question" | "task_completed" }
  | { state: "waiting_permission"; detail: "tool_approval" }
  | { state: "starting" }
  | { state: "idle" }
  | { state: "exited" };

export interface ResolvedStatus {
  agentStatus: AgentStatus;
  detailed: DetailedStatus;
  toolName?: string;
}

/** Raw hook event as written to the JSONL sideband file. */
export interface HookEvent {
  /** Hook name, e.g. "PreToolUse", "Stop", "Notification" */
  hook: string;
  /** Session ID from the CLI (Claude's internal session ID) */
  sessionId?: string;
  /** Tool name (PreToolUse / PostToolUse / PostToolUseFailure) */
  toolName?: string;
  /** Error message (PostToolUseFailure) */
  error?: string;
  /** Notification type: "permission_prompt", "idle_prompt", "elicitation_dialog" */
  notificationType?: string;
  /** Model info from SessionStart */
  model?: string;
  /** Raw JSON payload passed via stdin (kept for forward-compatibility) */
  raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Claude Code hook resolvers
// ---------------------------------------------------------------------------

const WRITING_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

export function resolveFromClaudeHook(event: HookEvent): ResolvedStatus {
  switch (event.hook) {
    case "PreToolUse": {
      const toolName = event.toolName ?? "unknown";
      const detail = WRITING_TOOLS.has(toolName) ? "writing" as const : "tool_use" as const;
      return {
        agentStatus: "running",
        detailed: { state: "running", detail },
        toolName,
      };
    }

    case "PostToolUse":
    case "PostToolUseFailure":
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "thinking" },
      };

    case "UserPromptSubmit":
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "thinking" },
      };

    case "PermissionRequest": {
      const toolName = event.toolName;
      return {
        agentStatus: "waiting_permission",
        detailed: { state: "waiting_permission", detail: "tool_approval" },
        toolName,
      };
    }

    case "Notification":
      if (event.notificationType === "permission_prompt") {
        return {
          agentStatus: "waiting_permission",
          detailed: { state: "waiting_permission", detail: "tool_approval" },
        };
      }
      if (event.notificationType === "idle_prompt") {
        return {
          agentStatus: "waiting_input",
          detailed: { state: "waiting_input", detail: "idle_timeout" },
        };
      }
      if (event.notificationType === "elicitation_dialog") {
        return {
          agentStatus: "waiting_input",
          detailed: { state: "waiting_input", detail: "ask_question" },
        };
      }
      // Unknown notification — treat as running
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "general" },
      };

    case "Stop":
      return {
        agentStatus: "waiting_input",
        detailed: { state: "waiting_input", detail: "prompt" },
      };

    case "SubagentStart":
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "subagent" },
      };

    case "SubagentStop":
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "thinking" },
      };

    case "TaskCompleted":
      return {
        agentStatus: "waiting_input",
        detailed: { state: "waiting_input", detail: "task_completed" },
      };

    case "PreCompact":
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "compacting" },
      };

    case "SessionStart":
      return {
        agentStatus: "starting",
        detailed: { state: "starting" },
      };

    case "SessionEnd":
      return {
        agentStatus: "exited",
        detailed: { state: "exited" },
      };

    default:
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "general" },
      };
  }
}

// ---------------------------------------------------------------------------
// Gemini CLI — OSC terminal title resolver
// ---------------------------------------------------------------------------

/**
 * Parse Gemini's OSC title string to determine status.
 * Gemini CLI with `--show-status` sets terminal title via OSC:
 *  - "◇ Ready" → waiting_input
 *  - "✦ Working" → running
 *  - "✋ Action Required" → waiting_permission
 */
export function resolveFromGeminiOscTitle(title: string): ResolvedStatus | null {
  const trimmed = title.trim();

  if (trimmed.includes("Ready")) {
    return {
      agentStatus: "waiting_input",
      detailed: { state: "waiting_input", detail: "prompt" },
    };
  }

  if (trimmed.includes("Working")) {
    return {
      agentStatus: "running",
      detailed: { state: "running", detail: "general" },
    };
  }

  if (trimmed.includes("Action Required")) {
    return {
      agentStatus: "waiting_permission",
      detailed: { state: "waiting_permission", detail: "tool_approval" },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Gemini CLI — hook resolver
// ---------------------------------------------------------------------------

export function resolveFromGeminiHook(event: HookEvent): ResolvedStatus {
  switch (event.hook) {
    case "BeforeTool": {
      const toolName = event.toolName ?? "unknown";
      const detail = WRITING_TOOLS.has(toolName) ? "writing" as const : "tool_use" as const;
      return {
        agentStatus: "running",
        detailed: { state: "running", detail },
        toolName,
      };
    }

    case "AfterTool":
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "thinking" },
      };

    case "BeforeAgent":
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "subagent" },
      };

    case "AfterAgent":
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "thinking" },
      };

    case "SessionStart":
      return {
        agentStatus: "starting",
        detailed: { state: "starting" },
      };

    case "SessionEnd":
      return {
        agentStatus: "exited",
        detailed: { state: "exited" },
      };

    default:
      return {
        agentStatus: "running",
        detailed: { state: "running", detail: "general" },
      };
  }
}

// ---------------------------------------------------------------------------
// OSC escape sequence extraction
// ---------------------------------------------------------------------------

/**
 * Extract OSC title from raw PTY data.
 * OSC format: ESC ] 0 ; <title> BEL  or  ESC ] 0 ; <title> ESC \
 */
export function extractOscTitle(data: string): string | null {
  // Match OSC 0 (set window title) or OSC 2 (set window title)
  const match = data.match(/\x1b\](?:0|2);([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
  return match?.[1] ?? null;
}
