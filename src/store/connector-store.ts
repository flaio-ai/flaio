import { createStore } from "zustand/vanilla";
import { ConnectorManager } from "../connectors/connector-manager.js";
import { SlackAdapter, type SlackConfig } from "../connectors/adapters/slack-adapter.js";
import type { ConnectorStatus } from "../connectors/connector-interface.js";
import { HookServer, type HookResponse } from "../hooks/hook-server.js";
import { installHooks } from "../hooks/install.js";
import { appStore, getSessionInstance } from "./app-store.js";
import { settingsStore } from "./settings-store.js";
import type { AgentStatus } from "../agents/drivers/base-driver.js";

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

let started = false;
let unsubSettings: (() => void) | null = null;
let unsubSessions: (() => void) | null = null;

// Session status tracking for notification transitions
const prevStatuses = new Map<string, AgentStatus>();

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
  lastSlackFields = null;

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
 * Bridge HookServer events → ConnectorManager
 */
function wireHookBridge(): void {
  // permission_request: async — await connector reply then call socket reply callback
  // If no connectors are connected, reply with "ack" (not "permission_reply")
  // so the hook falls through instead of denying.
  hookServer.on(
    "permission_request",
    (payload: Record<string, unknown>, reply: (response: HookResponse) => void) => {
      const connected = connectorManager.getAll().filter((c) => c.status === "connected");
      if (connected.length === 0) {
        // No connectors to ask — let hook fall through to default behavior
        reply({ type: "ack", payload: {} });
        return;
      }

      const cwd = String(payload.cwd ?? "");
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

  // notification: agent response — forward as "response" notification
  hookServer.on("notification", (payload: Record<string, unknown>) => {
    const cwd = String(payload.cwd ?? "");
    const sessionId = resolveInternalSessionId(String(payload.sessionId ?? ""), cwd);
    const message = String(payload.message ?? "");
    if (!message) return;

    connectorManager
      .postNotification({
        sessionId,
        type: "response",
        message,
        cwd,
      })
      .catch(() => {});
  });

  // stop: session stopped notification
  hookServer.on("stop", (payload: Record<string, unknown>) => {
    const cwd = String(payload.cwd ?? "");
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
      session.write(text + "\n");
    }
  });
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
        } else if (s.status === "waiting_input") {
          connectorManager
            .postNotification({
              sessionId: s.id,
              type: "waiting_input",
              message: `Session is waiting for input (${s.displayName})`,
              cwd: s.cwd,
            })
            .catch(() => {});
        } else if (s.status === "exited") {
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

    // Clean up map entries for removed sessions
    for (const id of prevStatuses.keys()) {
      if (!currentIds.has(id)) {
        prevStatuses.delete(id);
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
