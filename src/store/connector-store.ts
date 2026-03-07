import { createStore } from "zustand/vanilla";
import { ConnectorManager } from "../connectors/connector-manager.js";
import { SlackAdapter, type SlackConfig } from "../connectors/adapters/slack-adapter.js";
import type { ConnectorStatus } from "../connectors/connector-interface.js";
import { HookServer, type HookResponse } from "../hooks/hook-server.js";
import { PortalServer } from "../portal/portal-server.js";
import { RelayClient } from "../relay/relay-client.js";
import { setRelayLoggedIn, clearSessionState } from "../relay/relay-store.js";
import { installHooks } from "../hooks/install.js";
import { appStore, getSessionInstance, setPermissionPending, clearPermissionPending } from "./app-store.js";
import { settingsStore } from "./settings-store.js";
import type { AgentStatus } from "../agents/drivers/base-driver.js";

import { trackCliEvent } from "../analytics/index.js";
import { makeDebugLog } from "../connectors/debug.js";

const debugLog = makeDebugLog("connector");

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
export const relayClient = new RelayClient();

let started = false;
let unsubSettings: (() => void) | null = null;
let unsubSessions: (() => void) | null = null;

// Session status tracking for notification transitions
const prevStatuses = new Map<string, AgentStatus>();
// Dedup: avoid posting the same response twice (waiting_input → exited, or hook + status transition)
const lastPostedResponse = new Map<string, string>();
// Track last post time per session to debounce rapid transitions
const lastPostTime = new Map<string, number>();
const DEDUP_WINDOW_MS = 3000;

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

  // Start relay if enabled and authenticated
  await syncRelayFromConfig();
  wireRelayConfigReactivity();
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

  if (relayDebounceTimer) {
    clearTimeout(relayDebounceTimer);
    relayDebounceTimer = null;
  }

  if (unsubSettings) {
    unsubSettings();
    unsubSettings = null;
  }

  if (unsubRelaySettings) {
    unsubRelaySettings();
    unsubRelaySettings = null;
  }

  if (unsubSessions) {
    unsubSessions();
    unsubSessions = null;
  }

  prevStatuses.clear();
  lastPostedResponse.clear();
  lastPostTime.clear();
  lastSlackFields = null;

  await relayClient.stop();
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

      // Show blue "waiting_permission" badge while awaiting connector reply.
      // Set status first, then arm the guard so the driver's 1s poll can't
      // overwrite it with "running".  The guard auto-clears if the agent
      // transitions to waiting_input/exited (self-healing).
      appStore.getState().updateSessionStatus(sessionId, "waiting_permission");
      setPermissionPending(sessionId);

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
        } finally {
          clearPermissionPending(sessionId);
          appStore.getState().updateSessionStatus(sessionId, "running");
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

    // Dedup: skip if we just posted this exact content via wireSessionNotifications
    if (message === lastPostedResponse.get(sessionId)) {
      const lastTime = lastPostTime.get(sessionId) ?? 0;
      if (Date.now() - lastTime < DEDUP_WINDOW_MS) {
        debugLog(`dedup: skipping hook notification for ${sessionId} (same as recent post)`);
        return;
      }
    }

    lastPostedResponse.set(sessionId, message);
    lastPostTime.set(sessionId, Date.now());

    connectorManager
      .postNotification({
        sessionId,
        type: "response",
        message,
        cwd,
      })
      .catch((err) => {
        debugLog(`hook notification post failed for ${sessionId}:`, String(err));
      });
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
      .catch((err) => {
        debugLog(`stop notification failed for ${sessionId}:`, String(err));
      });
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
 * Extract only the agent's latest response.
 * First tries the viewport content (from the session instance, already processed by xterm).
 * Falls back to the full scrollback buffer when the prompt scrolled off-screen.
 */
function extractLatestResponse(sessionId: string): string | null {
  const session = getSessionInstance(sessionId);
  if (!session) return null;

  // Primary: use viewport content from the session (reliable — already flushed by xterm)
  const content = session.getContent();
  if (content && content.length > 0) {
    const viewportLines = content.map((line) =>
      line.map((span) => span.text).join("").trimEnd(),
    );
    const result = extractFromLines(viewportLines);
    if (result) return result;
  }

  // Fallback: read scrollback for long responses where prompt scrolled off viewport
  return extractFromLines(session.getPlainText(500));
}

/**
 * Find the last user prompt (❯ with text), take lines after it,
 * and strip terminal chrome / hook output.
 */
function extractFromLines(allLines: string[]): string | null {
  // Find the last user prompt line — several prompt styles:
  // "❯ sometext", "$ sometext", or Claude Code's "human>" / "H:"
  // NOTE: ">" is intentionally excluded — it matches Markdown blockquotes
  // (`> quoted text`) which appear in agent responses, causing truncation.
  let promptIdx = -1;
  for (let i = allLines.length - 1; i >= 0; i--) {
    const l = allLines[i];
    // Match "❯ sometext" or "$ sometext" but not bare prompts
    if (/^[❯$]\s+\S/.test(l)) {
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
    // Dividers (solid lines of dashes, equals, etc.)
    if (/^[─━═\-]+$/.test(l)) return false;
    // Box drawing borders
    if (/^[╭╰╮╯│┌└┐┘├┤┬┴┼]/.test(l)) return false;
    if (/[╭╰╮╯│┌└┐┘├┤┬┴┼]$/.test(l.trimEnd())) return false;
    // Empty prompt line (excludes ">" — see prompt-detection note above)
    if (/^[❯$]\s*$/.test(l)) return false;
    // Hook output lines
    if (/^\s*⏺\s+(Ran|Running|Read|Edit|Write|Bash|Glob|Grep|Task)\b/.test(l)) return false;
    if (/^\s*[⎿]\s/.test(l)) return false;
    if (/hook error/i.test(l)) return false;
    // Claude Code status/chrome lines
    if (/\?\s+for shortcuts/i.test(l)) return false;
    if (/\/ide\s+for\s/i.test(l)) return false;
    if (/\/help/i.test(l) && /shortcuts|commands/i.test(l)) return false;
    // Update/install notices
    if (/update available/i.test(l)) return false;
    if (/npm install -g/i.test(l)) return false;
    if (/npm update/i.test(l)) return false;
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
    // Progress bars / spinners
    if (/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]\s/.test(l)) return false;
    // ANSI escape-only lines (after stripping — but these appear as empty)
    if (l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim() === "") return false;
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
            .catch((err) => {
              debugLog(`started notification failed for ${s.id}:`, String(err));
            });
        } else if (
          s.status === "running" &&
          (prev === "waiting_input" || prev === "idle")
        ) {
          // Agent started working — emit typing notification for placeholder
          connectorManager
            .postNotification({
              sessionId: s.id,
              type: "typing",
              message: "Thinking...",
              cwd: s.cwd,
            })
            .catch((err) => {
              debugLog(`typing notification failed for ${s.id}:`, String(err));
            });
        } else if (s.status === "waiting_input" || s.status === "exited") {
          // Agent finished responding — extract latest response after a short
          // delay so the ScreenBuffer's 30fps debounce can flush fresh content.
          const sessionId = s.id;
          const cwd = s.cwd;
          const displayName = s.displayName;
          const isExited = s.status === "exited";

          setTimeout(() => {
            const response = extractLatestResponse(sessionId);
            if (response) {
              // Dedup: skip if same content posted recently (hook or prior transition)
              const lastContent = lastPostedResponse.get(sessionId);
              const lastTime = lastPostTime.get(sessionId) ?? 0;
              if (response === lastContent && Date.now() - lastTime < DEDUP_WINDOW_MS) {
                debugLog(`dedup: skipping status-transition post for ${sessionId}`);
              } else {
                lastPostedResponse.set(sessionId, response);
                lastPostTime.set(sessionId, Date.now());
                connectorManager
                  .postNotification({
                    sessionId,
                    type: "response",
                    message: response,
                    cwd,
                  })
                  .catch((err) => {
                    debugLog(`response post failed for ${sessionId}:`, String(err));
                  });
              }
            } else {
              debugLog(`no extractable response for ${sessionId} after transition`);
            }

            if (isExited) {
              connectorManager
                .postNotification({
                  sessionId,
                  type: "stopped",
                  message: `Session exited (${displayName})`,
                  cwd,
                })
                .catch((err) => {
                  debugLog(`exit notification failed for ${sessionId}:`, String(err));
                });
            }
          }, 150);
        }
      }
    }

    // Clean up map entries for removed sessions
    for (const id of prevStatuses.keys()) {
      if (!currentIds.has(id)) {
        prevStatuses.delete(id);
        lastPostedResponse.delete(id);
        lastPostTime.delete(id);
        clearSessionState(id);

        // Clean up Slack adapter per-session state
        const slack = connectorManager.get("slack");
        if (slack && "cleanupSession" in slack) {
          (slack as any).cleanupSession(id);
        }
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

// ---------------------------------------------------------------------------
// Relay client lifecycle
// ---------------------------------------------------------------------------

let relayDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let relaySyncInProgress = false;
let lastRelayFields: string | null = null;
let unsubRelaySettings: (() => void) | null = null;

async function syncRelayFromConfig(): Promise<void> {
  const { config } = settingsStore.getState();
  const relay = config.relay;

  setRelayLoggedIn(!!relay.authToken);

  // Stop relay if disabled or no token
  if (!relay.enabled || !relay.authToken) {
    await relayClient.stop();
    return;
  }

  // Start if auto-connect is on
  if (relay.autoConnect) {
    await relayClient.start();
    trackCliEvent("cli_session_connected");
  }
}

function wireRelayConfigReactivity(): void {
  lastRelayFields = serializeRelayConfig();

  unsubRelaySettings = settingsStore.subscribe(() => {
    const current = serializeRelayConfig();
    if (current === lastRelayFields) return;
    lastRelayFields = current;

    if (relayDebounceTimer) clearTimeout(relayDebounceTimer);
    relayDebounceTimer = setTimeout(() => {
      relayDebounceTimer = null;
      if (relaySyncInProgress) return;
      relaySyncInProgress = true;
      syncRelayFromConfig().finally(() => {
        relaySyncInProgress = false;
      });
    }, 1000);
  });
}

function serializeRelayConfig(): string {
  const { config } = settingsStore.getState();
  const r = config.relay;
  return JSON.stringify([r.enabled, r.authToken, r.autoConnect]);
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
