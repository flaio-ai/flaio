import React from "react";
import path from "node:path";
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
      borderStyle="round"
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
            name={path.basename(session.cwd)}
            status={session.status}
            isActive={session.id === activeSessionId}
            index={index}
            width={width - 2}
          />
        ))
      )}

      <Box flexGrow={1} />
    </Box>
  );
}
