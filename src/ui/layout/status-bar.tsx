import React, { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { SessionState } from "../../store/app-store.js";
import { connectorStatusStore, type ConnectorBadge } from "../../store/connector-store.js";
import type { ConnectorStatus } from "../../connectors/connector-interface.js";
import { relayStore, type RelayConnectionStatus } from "../../relay/relay-store.js";
import { settingsStore } from "../../store/settings-store.js";
import { useUpdateCheck } from "../hooks/use-update-check.js";

const CONNECTOR_ICONS: Record<string, string> = {
  slack: "#",
  discord: "𝐃",
  telegram: "✈",
};

const STATUS_STYLE: Record<ConnectorStatus, { symbol: string; color: string }> = {
  connected:    { symbol: "●", color: "green" },
  connecting:   { symbol: "◐", color: "yellow" },
  disconnected: { symbol: "○", color: "gray" },
  error:        { symbol: "●", color: "red" },
};

function useConnectorBadges(): ConnectorBadge[] {
  return useSyncExternalStore(
    connectorStatusStore.subscribe,
    () => connectorStatusStore.getState().connectors,
  );
}

const RELAY_STATUS_STYLE: Record<RelayConnectionStatus, { symbol: string; color: string }> = {
  connected:      { symbol: "●", color: "green" },
  connecting:     { symbol: "◐", color: "yellow" },
  authenticating: { symbol: "◐", color: "yellow" },
  disconnected:   { symbol: "○", color: "gray" },
  error:          { symbol: "●", color: "red" },
};

function useRelayState() {
  return useSyncExternalStore(
    relayStore.subscribe,
    () => relayStore.getState(),
  );
}

/** Format the session status badge with rich detail when available. */
function formatDetailedStatus(session: SessionState): { text: string; color: string } {
  const detailed = session.detailedStatus;

  // Base status color mapping
  const baseColor =
    session.status === "running" ? "green"
    : session.status === "waiting_input" ? "#FFA500"
    : session.status === "waiting_permission" ? "#3B82F6"
    : session.status === "exited" ? "red"
    : "gray";

  // If no detailed status, fall back to basic display
  if (!detailed || !("detail" in detailed)) {
    const text = session.status === "waiting_permission" ? "permission" : session.status;
    return { text, color: baseColor };
  }

  const { state, detail } = detailed as { state: string; detail: string };

  if (state === "running") {
    switch (detail) {
      case "tool_use":
        return { text: session.currentTool ? `tool [${session.currentTool}]` : "tool", color: "green" };
      case "writing":
        return { text: session.currentTool ? `writing [${session.currentTool}]` : "writing", color: "green" };
      case "thinking":
        return { text: "thinking", color: "green" };
      case "subagent":
        return { text: "subagent", color: "green" };
      case "compacting":
        return { text: "compacting", color: "yellow" };
      default:
        return { text: "running", color: "green" };
    }
  }

  if (state === "waiting_input") {
    switch (detail) {
      case "ask_question":
        return { text: "question", color: "#FFA500" };
      case "idle_timeout":
        return { text: "idle", color: "#FFA500" };
      case "task_completed":
        return { text: "completed", color: "#FFA500" };
      default:
        return { text: "waiting", color: "#FFA500" };
    }
  }

  if (state === "waiting_permission") {
    return { text: "permission", color: "#3B82F6" };
  }

  return { text: session.status, color: baseColor };
}

/** Format cost for display: $0.0123 */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Format model name with version from modelId.
 * e.g. modelId="claude-opus-4-6" → "Opus 4.6"
 *      modelId="claude-sonnet-4-6" → "Sonnet 4.6"
 *      modelId="claude-haiku-4-5-20251001" → "Haiku 4.5"
 */
function formatModelName(displayName: string, modelId?: string): string {
  // Try to extract family + version from modelId
  if (modelId) {
    const match = modelId.match(/claude-(\w+)-(\d+)-(\d+)/);
    if (match) {
      const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
      return `${family} ${match[2]}.${match[3]}`;
    }
  }
  // Fallback: use display name
  if (displayName.includes("Opus")) return "Opus";
  if (displayName.includes("Sonnet")) return "Sonnet";
  if (displayName.includes("Haiku")) return "Haiku";
  const parts = displayName.split(/[\s/]/);
  return parts[parts.length - 1] ?? displayName;
}

/** Format lines changed: +42/-3 */
function formatLines(added?: number, removed?: number): string | null {
  if (added == null && removed == null) return null;
  return `+${added ?? 0}/-${removed ?? 0}`;
}

interface StatusBarProps {
  activeSession: SessionState | undefined;
  sessionCount: number;
}

export function StatusBar({
  activeSession,
  sessionCount,
}: StatusBarProps): React.ReactElement {
  const connectors = useConnectorBadges();
  const updateInfo = useUpdateCheck();
  const relay = useRelayState();
  const showCost = useSyncExternalStore(
    settingsStore.subscribe,
    () => settingsStore.getState().config.ui.showCost,
  );

  return (
    <Box height={1} paddingX={1} justifyContent="flex-end">
      <Box>
        {updateInfo && (
          <Text>
            <Text color="yellow">v{updateInfo.latest} available</Text>
            <Text dimColor> | </Text>
          </Text>
        )}
        {[...relay.sessionEncryptionStatus.values()].some((s) => s === "failed") && (
          <Text>
            <Text color="red" bold>E2E FAILED</Text>
            <Text dimColor> | </Text>
          </Text>
        )}
        {relay.connectionStatus !== "disconnected" && (
          <Text>
            <Text color={RELAY_STATUS_STYLE[relay.connectionStatus].color}>
              {RELAY_STATUS_STYLE[relay.connectionStatus].symbol}
            </Text>
            <Text color={RELAY_STATUS_STYLE[relay.connectionStatus].color}>
              Relay
            </Text>
            {relay.connectionStatus === "connecting" && relay.reconnectAttempt > 0 && (
              <Text color="yellow"> retry {relay.reconnectAttempt}</Text>
            )}
            {relay.connectionStatus === "error" && relay.errorMessage && (
              <Text color="red" dimColor> {relay.errorMessage.length > 25 ? relay.errorMessage.slice(0, 25) + "…" : relay.errorMessage}</Text>
            )}
            {relay.totalViewerCount > 0 && (
              <Text color="cyan"> ({relay.totalViewerCount})</Text>
            )}
            <Text dimColor> | </Text>
          </Text>
        )}
        {connectors.map((c) => {
          const style = STATUS_STYLE[c.status];
          const icon = CONNECTOR_ICONS[c.name] ?? c.name;
          return (
            <Text key={c.name}>
              <Text color={style.color}>{style.symbol}</Text>
              <Text color={style.color}>{icon}{c.displayName}</Text>
              {c.status === "error" && c.error && (
                <Text color="red" dimColor> {c.error.length > 30 ? c.error.slice(0, 30) + "…" : c.error}</Text>
              )}
              <Text dimColor> | </Text>
            </Text>
          );
        })}
        {activeSession && (() => {
          const statusInfo = formatDetailedStatus(activeSession);
          const modelLabel = activeSession.modelDisplayName
            ? formatModelName(activeSession.modelDisplayName, activeSession.modelId)
            : null;
          const linesLabel = formatLines(activeSession.totalLinesAdded, activeSession.totalLinesRemoved);
          const hasMeta = modelLabel || activeSession.usedPercentage != null || linesLabel || (showCost && activeSession.totalCostUsd != null);
          return (
            <>
              <Text>
                <Text color={statusInfo.color}>{statusInfo.text}</Text>
              </Text>
              {hasMeta && (
                <Text dimColor>
                  {modelLabel && ` ${modelLabel}`}
                  {activeSession.usedPercentage != null && ` ctx ${Math.round(activeSession.usedPercentage)}%`}
                  {linesLabel && ` ${linesLabel}`}
                  {showCost && activeSession.totalCostUsd != null && ` ${formatCost(activeSession.totalCostUsd)}`}
                </Text>
              )}
              <Text dimColor> | </Text>
            </>
          );
        })()}
        <Text dimColor>
          {sessionCount} session{sessionCount !== 1 ? "s" : ""}
        </Text>
        <Text dimColor> | Ctrl+G Help</Text>
      </Box>
    </Box>
  );
}
