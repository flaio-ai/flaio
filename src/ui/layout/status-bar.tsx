import React, { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { SessionState } from "../../store/app-store.js";
import { connectorStatusStore, type ConnectorBadge } from "../../store/connector-store.js";
import type { ConnectorStatus } from "../../connectors/connector-interface.js";
import { relayStore, type RelayConnectionStatus } from "../../relay/relay-store.js";
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

  return (
    <Box height={1} paddingX={1} justifyContent="flex-end">
      <Box>
        {updateInfo && (
          <Text>
            <Text color="yellow">v{updateInfo.latest} available</Text>
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
              <Text dimColor> | </Text>
            </Text>
          );
        })}
        {activeSession && (
          <Text>
            <Text color={activeSession.status === "running" ? "green" : activeSession.status === "waiting_input" ? "#FFA500" : activeSession.status === "waiting_permission" ? "#3B82F6" : activeSession.status === "exited" ? "red" : "gray"}>
              {activeSession.status === "waiting_permission" ? "permission" : activeSession.status}
            </Text>
            <Text dimColor> | </Text>
          </Text>
        )}
        <Text dimColor>
          {sessionCount} session{sessionCount !== 1 ? "s" : ""}
        </Text>
        <Text dimColor> | Ctrl+G Help</Text>
      </Box>
    </Box>
  );
}
