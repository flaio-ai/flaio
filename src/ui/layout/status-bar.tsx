import React from "react";
import { Box, Text } from "ink";
import type { SessionState } from "../../store/app-store.js";

interface StatusBarProps {
  activeSession: SessionState | undefined;
  sessionCount: number;
}

export function StatusBar({
  activeSession,
  sessionCount,
}: StatusBarProps): React.ReactElement {
  return (
    <Box height={1} paddingX={1} justifyContent="flex-end">
      <Box>
        {activeSession && (
          <Text>
            <Text color={activeSession.status === "running" ? "green" : activeSession.status === "waiting_input" ? "#FFA500" : activeSession.status === "exited" ? "red" : "gray"}>
              {activeSession.status}
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
