import React from "react";
import { Box, Text } from "ink";
import { TerminalView } from "../components/terminal-view.js";
import type { AgentSession } from "../../agents/agent-session.js";
import type { SessionState } from "../../store/app-store.js";

interface MainPaneProps {
  session: AgentSession | null;
  sessionState: SessionState | undefined;
  width: number;
  height: number;
}

export function MainPane({
  session,
  sessionState,
  width,
  height,
}: MainPaneProps): React.ReactElement {
  const headerHeight = 1;
  const termHeight = height - headerHeight;

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {/* Header bar */}
      <Box height={headerHeight} paddingX={1}>
        {sessionState ? (
          <>
            <Text bold>{sessionState.displayName}</Text>
            <Text dimColor> — {sessionState.cwd}</Text>
          </>
        ) : (
          <Text dimColor>No session selected</Text>
        )}
      </Box>

      {/* Terminal area */}
      <TerminalView
        session={session}
        width={width}
        height={termHeight > 0 ? termHeight : 1}
      />
    </Box>
  );
}
