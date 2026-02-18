import React from "react";
import { Box, Text, useInput } from "ink";
import type { DetectedAgent } from "../../agents/agent-detector.js";

interface StandaloneAgentsProps {
  agents: DetectedAgent[];
  selectedIndex: number;
  onSelect: (agent: DetectedAgent) => void;
  onNavigate: (delta: number) => void;
}

export function StandaloneAgents({
  agents,
  selectedIndex,
  onSelect,
  onNavigate,
}: StandaloneAgentsProps): React.ReactElement {
  useInput((input, key) => {
    if (key.upArrow) onNavigate(-1);
    if (key.downArrow) onNavigate(1);
    if (key.return && agents[selectedIndex]) {
      onSelect(agents[selectedIndex]!);
    }
  });

  if (agents.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No standalone agents detected</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold dimColor>
        Standalone Agents:
      </Text>
      {agents.map((agent, i) => (
        <Box key={agent.pid} paddingLeft={1}>
          <Text
            color={i === selectedIndex ? "cyan" : undefined}
            bold={i === selectedIndex}
          >
            {i === selectedIndex ? ">" : " "} {agent.displayName} (PID:{agent.pid})
          </Text>
          {agent.cwd && (
            <Text dimColor> {agent.cwd}</Text>
          )}
        </Box>
      ))}
      <Text dimColor>Enter: bring in | Arrows: navigate</Text>
    </Box>
  );
}
