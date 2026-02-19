import React, { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { SessionState } from "../../store/app-store.js";
import { connectorStatusStore, type ConnectorBadge } from "../../store/connector-store.js";
import type { ConnectorStatus } from "../../connectors/connector-interface.js";

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

interface StatusBarProps {
  activeSession: SessionState | undefined;
  sessionCount: number;
}

export function StatusBar({
  activeSession,
  sessionCount,
}: StatusBarProps): React.ReactElement {
  const connectors = useConnectorBadges();

  return (
    <Box height={1} paddingX={1} justifyContent="flex-end">
      <Box>
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
