import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DetectedAgent } from "../../agents/agent-detector.js";

interface AdoptAgentDialogProps {
  agents: DetectedAgent[];
  onAdopt: (agent: DetectedAgent) => void;
  onCancel: () => void;
}

export function AdoptAgentDialog({
  agents,
  onAdopt,
  onCancel,
}: AdoptAgentDialogProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (agents.length === 0) return;

    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(i + 1, agents.length - 1));
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }

    if (key.return) {
      const agent = agents[selectedIndex];
      if (agent) onAdopt(agent);
    }
  });

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        width={60}
      >
        <Text bold color="cyan">
          Adopt Standalone Agent
        </Text>

        {agents.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor>No standalone agents detected. Press Esc to close.</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {agents.map((agent, i) => (
              <Box key={agent.pid}>
                <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
                  {i === selectedIndex ? "▸ " : "  "}
                  {agent.displayName} PID:{agent.pid}
                  {agent.cwd ? ` ${agent.cwd}` : ""}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>
            {agents.length > 0
              ? "↑↓ navigate · Enter adopt · Esc cancel"
              : "Esc close"}
          </Text>
        </Box>
        {agents.length > 0 && (
          <Text dimColor italic>
            The external process will be stopped and resumed in a new tab.
          </Text>
        )}
      </Box>
    </Box>
  );
}
