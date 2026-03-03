import React from "react";
import path from "node:path";
import { Box, Text } from "ink";
import { AgentTab } from "../components/agent-tab.js";
import { StandaloneAgents } from "../components/standalone-agents.js";
import type { SessionState } from "../../store/app-store.js";
import type { DetectedAgent } from "../../agents/agent-detector.js";

interface SidebarProps {
  sessions: SessionState[];
  activeSessionId: string | null;
  width: number;
  detectedAgents: DetectedAgent[];
}

export function Sidebar({
  sessions,
  activeSessionId,
  width,
  detectedAgents,
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
          Flaio
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
      <StandaloneAgents agents={detectedAgents} width={width - 4} />
    </Box>
  );
}
