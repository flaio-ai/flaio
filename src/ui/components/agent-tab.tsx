import React from "react";
import { Box, Text } from "ink";
import type { AgentStatus } from "../../agents/drivers/base-driver.js";
import { useSpinner } from "../hooks/use-spinner.js";

export const STATUS_INDICATORS: Record<AgentStatus, { symbol: string; color: string }> = {
  idle: { symbol: "○", color: "gray" },
  starting: { symbol: "◐", color: "yellow" },
  running: { symbol: "●", color: "green" },
  waiting_input: { symbol: "●", color: "#FFA500" },
  waiting_permission: { symbol: "■", color: "#3B82F6" },
  exited: { symbol: "○", color: "red" },
};

/** Exit-specific indicators based on exit code */
const EXIT_INDICATORS = {
  clean: { symbol: "✓", color: "green" },
  error: { symbol: "○", color: "red" },
} as const;

interface AgentTabProps {
  name: string;
  status: AgentStatus;
  isActive: boolean;
  index: number;
  width?: number;
  exitCode?: number;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

/** Spinner that only mounts when the agent is running — avoids 150ms re-renders for idle/exited tabs */
function SpinnerSymbol({ color }: { color: string }): React.ReactElement {
  const frame = useSpinner();
  return <Text color={color}>{frame}</Text>;
}

function AgentTabInner({
  name,
  status,
  isActive,
  index,
  width,
  exitCode,
}: AgentTabProps): React.ReactElement {
  const indicator = status === "exited"
    ? (exitCode === 0 ? EXIT_INDICATORS.clean : EXIT_INDICATORS.error)
    : STATUS_INDICATORS[status];

  // number(2) + space(1) + dot(1) = 4 chars of overhead inside the box
  // borders add 2 cols, so available inner width = (width ?? 20) - 2
  const innerWidth = (width ?? 20) - 2;
  const maxNameLen = Math.max(4, innerWidth - 4);
  const displayName = truncate(name, maxNameLen);

  return (
    <Box
      borderStyle="round"
      borderColor={isActive ? "cyan" : "gray"}
      width={width}
    >
      <Box justifyContent="space-between" width="100%">
        <Box>
          <Text color="gray">{index + 1} </Text>
          <Text bold={isActive} color={isActive ? "white" : undefined}>
            {displayName}
          </Text>
        </Box>
        {status === "running" ? (
          <SpinnerSymbol color={indicator.color} />
        ) : (
          <Text color={indicator.color}>{indicator.symbol}</Text>
        )}
      </Box>
    </Box>
  );
}

export const AgentTab = React.memo(AgentTabInner);
