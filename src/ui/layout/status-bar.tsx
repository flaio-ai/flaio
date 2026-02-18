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
    <Box height={1} paddingX={1} justifyContent="space-between">
      <Box>
        <Text dimColor>
          Ctrl+Q:Quit Ctrl+T:New Ctrl+W:Close Scroll:MouseWheel/Ctrl+U/D
        </Text>
      </Box>
      <Box>
        {activeSession && (
          <Text>
            <Text color={activeSession.status === "running" ? "green" : activeSession.status === "waiting_input" ? "yellow" : "gray"}>
              {activeSession.status}
            </Text>
            <Text dimColor> | </Text>
          </Text>
        )}
        <Text dimColor>
          {sessionCount} session{sessionCount !== 1 ? "s" : ""}
        </Text>
      </Box>
    </Box>
  );
}
