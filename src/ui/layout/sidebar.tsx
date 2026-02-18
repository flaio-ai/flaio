import React from "react";
import { Box, Text } from "ink";
import { AgentTab } from "../components/agent-tab.js";
import type { SessionState } from "../../store/app-store.js";

interface SidebarProps {
  sessions: SessionState[];
  activeSessionId: string | null;
  width: number;
}

export function Sidebar({
  sessions,
  activeSessionId,
  width,
}: SidebarProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor="gray"
      paddingX={0}
    >
      <Box paddingX={1} marginBottom={1}>
        <Text bold color="cyan">
          Agent Manager
        </Text>
      </Box>

      {sessions.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>No sessions</Text>
        </Box>
      ) : (
        sessions.map((session, index) => (
          <AgentTab
            key={session.id}
            name={session.displayName}
            status={session.status}
            isActive={session.id === activeSessionId}
            index={index}
          />
        ))
      )}

      <Box flexGrow={1} />

      <Box paddingX={1} flexDirection="column" borderStyle="single" borderTop borderColor="gray">
        <Text dimColor>Ctrl+Q Quit</Text>
        <Text dimColor>Ctrl+T New</Text>
        <Text dimColor>Ctrl+W Close</Text>
        <Text dimColor>Ctrl+N/P Switch</Text>
      </Box>
    </Box>
  );
}
