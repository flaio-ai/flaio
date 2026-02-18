import React from "react";
import { Box, Text } from "ink";
import type { AgentStatus } from "../../agents/drivers/base-driver.js";

interface AgentTabProps {
  name: string;
  status: AgentStatus;
  isActive: boolean;
  index: number;
}

const STATUS_INDICATORS: Record<AgentStatus, { symbol: string; color: string }> = {
  idle: { symbol: "○", color: "gray" },
  starting: { symbol: "◐", color: "yellow" },
  running: { symbol: "●", color: "green" },
  waiting_input: { symbol: "●", color: "#FFA500" },
  exited: { symbol: "○", color: "red" },
};

export function AgentTab({
  name,
  status,
  isActive,
  index,
}: AgentTabProps): React.ReactElement {
  const indicator = STATUS_INDICATORS[status];

  return (
    <Box paddingX={1}>
      <Text color={indicator.color}>{indicator.symbol} </Text>
      <Text bold={isActive} underline={isActive}>
        {index + 1}:{name}
      </Text>
    </Box>
  );
}
