import { createStore } from "zustand/vanilla";
import { ConnectorManager } from "../connectors/connector-manager.js";
import { SlackAdapter, type SlackConfig } from "../connectors/adapters/slack-adapter.js";
import type { ConnectorStatus } from "../connectors/connector-interface.js";
import { HookServer, type HookResponse } from "../hooks/hook-server.js";
import { PortalServer } from "../portal/portal-server.js";
import { installHooks } from "../hooks/install.js";
import { appStore, getSessionInstance } from "./app-store.js";
import { settingsStore } from "./settings-store.js";
import type { AgentStatus } from "../agents/drivers/base-driver.js";
import type { ScreenContent } from "../terminal/screen-buffer.js";

// ---------------------------------------------------------------------------
// Connector status store — reactive state for the UI
// ---------------------------------------------------------------------------

export interface ConnectorBadge {
  name: string;
  displayName: string;
  status: ConnectorStatus;
}

interface ConnectorStatusState {
  connectors: ConnectorBadge[];
}

export const connectorStatusStore = createStore<ConnectorStatusState>(() => ({
  connectors: [],
}));

function publishConnectorStatuses(): void {
  const badges: ConnectorBadge[] = connectorManager.getAll().map((c) => ({
    name: c.name,
    displayName: c.displayName,
    status: c.status,
  }));
  connectorStatusStore.setState({ connectors: badges });
}

// ---------------------------------------------------------------------------
// Module-level singletons (same pattern as agentDetector in app-store.ts)
// ---------------------------------------------------------------------------
const connectorManager = new ConnectorManager();
const hookServer = new HookServer();
const portalServer = new PortalServer();

let started = false;
let unsubSettings: (() => void) | null = null;
let unsubSessions: (() => void) | null = null;

// Session status tracking for notification transitions
const prevStatuses = new Map<string, AgentStatus>();
// Dedup: avoid posting the same response twice (waiting_input → exited)
const lastPostedResponse = new Map<string, string>();

// Debounce + mutex state for config reactivity
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let syncInProgress = false;
let lastSlackFields: string | null = null;

/**
 * Start the HookServer IPC and wire all bridges.
 * Safe to call multiple times — only the first call has effect.
 */
export async function startConnectors(): Promise<void> {
  if (started) return;
  started = true;

  // Ensure settings are loaded before reading config
  if (!settingsStore.getState().loaded) {
    settingsStore.getState().load();
  }

  // Install/upgrade hooks in ~/.claude/settings.json (replaces legacy hooks)
  installHooks({ silent: true });

  await hookServer.start();
  await portalServer.start();

  wireHookBridge();
  wirePromptBridge();
  wireSessionNotifications();
  await syncSlackFromConfig();
  wireConfigReactivity();
}

/**
 * Tear down everything cleanly.
 */
export async function stopConnectors(): Promise<void> {
  if (!started) return;
  started = false;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (unsubSettings) {
    unsubSettings();
    unsubSettings = null;
  }

  if (unsubSessions) {
    unsubSessions();
    unsubSessions = null;
  }

  prevStatuses.clear();
  lastPostedResponse.clear();
  lastSlackFields = null;

  await portalServer.stop();
  await connectorManager.disconnectAll();
  publishConnectorStatuses();
  await hookServer.stop();
}

// ---------------------------------------------------------------------------
// Internal wiring
// ---------------------------------------------------------------------------

/**
 * Resolve a hook-originated session ID (Claude Code's session_id) to our
 * internal AgentSession.id by matching on cwd.  Falls back to the hook
 * session ID as-is when no match is found.
 */
function resolveInternalSessionId(hookSessionId: string, cwd: string): string {
  if (!cwd) return hookSessionId;
  const match = appStore.getState().sessions.find((s) => s.cwd === cwd);
  return match ? match.id : hookSessionId;
}

/**
 * Check whether the hook event originated from an agent session managed by
 * this app (matched by cwd).  External/standalone Claude Code instances
 * should NOT have their events forwarded to Slack.
 */
function isInternalSession(cwd: string): boolean {
  if (!cwd) return false;
  return appStore.getState().sessions.some((s) => s.cwd === cwd);
}

/**
 * Bridge HookServer events → ConnectorManager
 */
function wireHookBridge(): void {
  // permission_request: async — await connector reply then call socket reply callback
  // If no connectors are connected or the agent isn't managed by this app,
  // reply with "ack" so the hook falls through instead of denying.
  hookServer.on(
    "permission_request",
    (payload: Record<string, unknown>, reply: (response: HookResponse) => void) => {
      const cwd = String(payload.cwd ?? "");

      // Only forward events from agents running inside this app
      if (!isInternalSession(cwd)) {
        reply({ type: "ack", payload: {} });
        return;
      }

      const connected = connectorManager.getAll().filter((c) => c.status === "connected");
      if (connected.length === 0) {
        // No connectors to ask — let hook fall through to default behavior
        reply({ type: "ack", payload: {} });
        return;
      }

      const sessionId = resolveInternalSessionId(String(payload.sessionId ?? ""), cwd);

      (async () => {
        try {
          const result = await connectorManager.requestPermission({
            sessionId,
            toolName: String(payload.toolName ?? ""),
            toolInput: (payload.toolInput as Record<string, unknown>) ?? {},
            cwd,
          });
          reply({
            type: "permission_reply",
            payload: { allowed: result.allowed, message: result.message },
          });
        } catch {
          reply({
            type: "permission_reply",
            payload: { allowed: false, message: "Connector error" },
          });
        }
      })();
    },
  );

  // post_tool_use: acknowledged but not forwarded to Slack
  // (agent responses are sent via the "notification" event instead)
  hookServer.on("post_tool_use", () => {});

  // notification: from Claude Code's Notification hook.
  // Filter out "waiting for input" noise — forward actual responses.
  // Only forward for agents managed by this app.
  hookServer.on("notification", (payload: Record<string, unknown>) => {
    const cwd = String(payload.cwd ?? "");
    if (!isInternalSession(cwd)) return;

    const sessionId = resolveInternalSessionId(String(payload.sessionId ?? ""), cwd);
    const message = String(payload.message ?? "");
    if (!message) return;

    // Filter out noise — desktop notifications about waiting for input
    const lower = message.toLowerCase();
    if (lower.includes("waiting for") || lower.includes("needs input") || lower.includes("needs your input")) return;

    connectorManager
      .postNotification({
        sessionId,
        type: "response",
        message,
        cwd,
      })
      .catch(() => {});
  });

  // stop: session stopped notification (only for managed agents)
  hookServer.on("stop", (payload: Record<string, unknown>) => {
    const cwd = String(payload.cwd ?? "");
    if (!isInternalSession(cwd)) return;

    const sessionId = resolveInternalSessionId(String(payload.sessionId ?? ""), cwd);

    connectorManager
      .postNotification({
        sessionId,
        type: "stopped",
        message: `Session exited (code ${payload.exitCode ?? "?"})`,
        cwd,
      })
      .catch(() => {});
  });
}

/**
 * Route inbound Slack messages to the correct agent's PTY input.
 * If a sessionId is provided (thread-routed), target that session directly.
 * Otherwise fall back to the active session.
 */
function wirePromptBridge(): void {
  connectorManager.on("prompt", (text: string, sessionId?: string) => {
    let session = sessionId ? getSessionInstance(sessionId) : null;
    if (!session) {
      session = appStore.getState().getActiveSession();
    }
    if (session) {
      // Write text first, then send Enter as a separate event after a short
      // delay so the agent's input handler can commit the text before submission.
      session.write(text);
      setTimeout(() => session!.write("\r"), 100);
    }
  });
}

/**
 * Extract only the agent's latest response from screen content.
 * Finds the last user prompt (❯ with text), takes lines after it,
 * and strips terminal chrome / hook output.
 */
function extractLatestResponse(content: ScreenContent | undefined): string | null {
  if (!content || content.length === 0) return null;

  // Flatten spans to plain text lines
  const allLines = content.map((line) =>
    line.map((span) => span.text).join("").trimEnd(),
  );

  // Find the last user prompt line: starts with ❯ followed by actual text
  let promptIdx = -1;
  for (let i = allLines.length - 1; i >= 0; i--) {
    const l = allLines[i];
    // Match "❯ sometext" but not a bare "❯" (empty prompt)
    if (/^❯\s+\S/.test(l)) {
      promptIdx = i;
      break;
    }
  }

  if (promptIdx < 0) return null;

  // Take lines after the prompt
  const after = allLines.slice(promptIdx + 1);

  // Filter out terminal chrome and noise
  const cleaned = after.filter((l) => {
    if (!l) return false;
    // Dividers
    if (/^[─━]+$/.test(l)) return false;
    // Box drawing borders
    if (/^[╭╰╮╯│┌└┐┘├┤┬┴┼]/.test(l)) return false;
    if (/[╭╰╮╯│┌└┐┘├┤┬┴┼]$/.test(l.trimEnd())) return false;
    // Empty prompt line
    if (/^❯\s*$/.test(l)) return false;
    // Hook output
    if (/^\s*⏺\s+Ran \d+/.test(l)) return false;
    if (/^\s*[⎿]\s/.test(l)) return false;
    if (/hook error/i.test(l)) return false;
    // Status bar / shortcuts / IDE hints (anywhere on line)
    if (/\?\s+for shortcuts/i.test(l)) return false;
    if (/\/ide\s+for\s/i.test(l)) return false;
    if (/\/help/i.test(l) && /shortcuts|commands/i.test(l)) return false;
    // Update notice
    if (/update available/i.test(l)) return false;
    if (/npm install -g/i.test(l)) return false;
    // Cost / token stats bar
    if (/^\s*\$[\d.]+\s+(cost|total)/i.test(l)) return false;
    if (/tokens?[:\s]+[\d,]+/i.test(l) && /cost|input|output/i.test(l)) return false;
    // Model name on its own line
    if (/^\s*claude-/i.test(l) && l.trim().length < 80) return false;
    // "Press Enter" / "Esc to cancel" prompts
    if (/^\s*(Press|Esc\s)/i.test(l)) return false;
    // Compact mode tip, auto-update notice
    if (/^\s*tip:/i.test(l)) return false;
    if (/^\s*Run\s.*to update/i.test(l)) return false;
    return true;
  });

  const text = cleaned.join("\n").trim();
  return text || null;
}

/**
 * Subscribe to appStore to detect session status transitions
 * and post notifications to connectors.
 */
function wireSessionNotifications(): void {
  // Initialize tracking from current state
  for (const s of appStore.getState().sessions) {
    prevStatuses.set(s.id, s.status);
  }

  unsubSessions = appStore.subscribe((state) => {
    const currentIds = new Set<string>();

    for (const s of state.sessions) {
      currentIds.add(s.id);
      const prev = prevStatuses.get(s.id);

      if (prev !== s.status) {
        prevStatuses.set(s.id, s.status);

        // Detect meaningful transitions
        if (prev === "starting" && s.status === "running") {
          connectorManager
            .postNotification({
              sessionId: s.id,
              type: "started",
              message: `Session started (${s.displayName})`,
              cwd: s.cwd,
            })
            .catch(() => {});
        } else if (s.status === "waiting_input" || s.status === "exited") {
          // Agent finished responding — extract only the latest response
          const response = extractLatestResponse(s.content);
          if (response && response !== lastPostedResponse.get(s.id)) {
            lastPostedResponse.set(s.id, response);
            connectorManager
              .postNotification({
                sessionId: s.id,
                type: "response",
                message: response,
                cwd: s.cwd,
              })
              .catch(() => {});
          }

          if (s.status === "exited") {
            connectorManager
              .postNotification({
                sessionId: s.id,
                type: "stopped",
                message: `Session exited (${s.displayName})`,
                cwd: s.cwd,
              })
              .catch(() => {});
          }
        }
      }
    }

    // Clean up map entries for removed sessions
    for (const id of prevStatuses.keys()) {
      if (!currentIds.has(id)) {
        prevStatuses.delete(id);
        lastPostedResponse.delete(id);
      }
    }
  });
}

/**
 * Sync SlackAdapter from current settings config.
 * Tears down existing adapter if present, then creates a new one if config is valid.
 */
async function syncSlackFromConfig(): Promise<void> {
  const { config } = settingsStore.getState();
  const slack = config.connectors.slack;

  // Tear down existing adapter if registered
  const existing = connectorManager.get("slack");
  if (existing) {
    try {
      await existing.disconnect();
    } catch {
      // Best effort
    }
    connectorManager.unregister("slack");
  }

  // Register and connect if enabled with required fields
  if (slack.enabled && slack.botToken && slack.channelId) {
    const adapterConfig: SlackConfig = {
      botToken: slack.botToken,
      channelId: slack.channelId,
      appToken: slack.appToken,
      pollInterval: slack.pollInterval,
      timeout: slack.timeout,
    };
    const adapter = new SlackAdapter(adapterConfig);
    connectorManager.register(adapter);

    try {
      await adapter.connect();
    } catch {
      // Error status is set inside the adapter
    }
  }

  publishConnectorStatuses();
}

/**
 * Watch settingsStore for Slack config changes.
 * Debounced (1s) with shallow comparison and mutex to prevent reconnect storms.
 */
function wireConfigReactivity(): void {
  // Snapshot initial state
  lastSlackFields = serializeSlackConfig();

  unsubSettings = settingsStore.subscribe(() => {
    const current = serializeSlackConfig();

    // Skip no-ops
    if (current === lastSlackFields) return;
    lastSlackFields = current;

    // Debounce to avoid reconnect storms while typing tokens
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;

      // Mutex to prevent concurrent syncs from interleaving
      if (syncInProgress) return;
      syncInProgress = true;
      syncSlackFromConfig().finally(() => {
        syncInProgress = false;
      });
    }, 1000);
  });
}

function serializeSlackConfig(): string {
  const { config } = settingsStore.getState();
  const s = config.connectors.slack;
  return JSON.stringify([
    s.enabled,
    s.botToken,
    s.appToken,
    s.channelId,
    s.pollInterval,
    s.timeout,
  ]);
}
