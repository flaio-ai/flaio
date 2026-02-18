import React from "react";
import path from "node:path";
import { Box, Text } from "ink";
import type { DetectedAgent } from "../../agents/agent-detector.js";

interface StandaloneAgentsProps {
  agents: DetectedAgent[];
  width: number;
}

const AGENT_ICONS: Record<string, string> = {
  claude: "◈",
  gemini: "◆",
};
const DEFAULT_ICON = "●";

export function StandaloneAgents({
  agents,
  width,
}: StandaloneAgentsProps): React.ReactElement | null {
  if (agents.length === 0) return null;

  const divider = "─".repeat(Math.max(width, 0));
  const title = "Standalone Agents";
  const countStr = ` ${agents.length}`;
  const gap = Math.max(width - 2 - title.length - countStr.length, 0);

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text dimColor>{divider}</Text>
      </Box>
      <Box paddingX={1}>
        <Text bold dimColor>
          {title}
          {" ".repeat(gap)}
          {countStr}
        </Text>
      </Box>
      {[...agents]
        .sort((a, b) => {
          const la = a.cwd ? path.basename(a.cwd) : `PID:${a.pid}`;
          const lb = b.cwd ? path.basename(b.cwd) : `PID:${b.pid}`;
          return la.localeCompare(lb);
        })
        .map((agent) => {
        const icon = AGENT_ICONS[agent.driverName] ?? DEFAULT_ICON;
        const label = agent.cwd ? path.basename(agent.cwd) : `PID:${agent.pid}`;
        return (
          <Box key={agent.pid} paddingX={1}>
            <Text color={agent.driverName === "claude" ? "#D97757" : "cyan"}>
              {icon}{" "}
            </Text>
            <Text>{label}</Text>
          </Box>
        );
      })}
      <Box paddingX={1}>
        <Text dimColor italic>
          Alt+A to adopt
        </Text>
      </Box>
    </Box>
  );
}
