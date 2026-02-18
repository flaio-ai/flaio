import React from "react";
import { Box, Text } from "ink";
import { Sidebar } from "./sidebar.js";
import { MainPane } from "./main-pane.js";
import { StatusBar } from "./status-bar.js";
import type { AgentSession } from "../../agents/agent-session.js";
import type { SessionState } from "../../store/app-store.js";
import type { AgentStatus } from "../../agents/drivers/base-driver.js";

const STATUS_INDICATORS: Record<AgentStatus, { symbol: string; color: string }> = {
  idle: { symbol: "○", color: "gray" },
  starting: { symbol: "◐", color: "yellow" },
  running: { symbol: "●", color: "green" },
  waiting_input: { symbol: "●", color: "#FFA500" },
  exited: { symbol: "○", color: "red" },
};

interface ShellProps {
  sessions: SessionState[];
  activeSessionId: string | null;
  activeInstance: AgentSession | null;
  sidebarVisible: boolean;
  columns: number;
  rows: number;
}

const SIDEBAR_WIDTH = 24;

function TopTabs({
  sessions,
  activeSessionId,
}: {
  sessions: SessionState[];
  activeSessionId: string | null;
}): React.ReactElement {
  return (
    <Box height={1} paddingX={1}>
      {sessions.map((session, i) => {
        const indicator = STATUS_INDICATORS[session.status];
        return (
          <Box key={session.id} marginRight={1}>
            <Text color={indicator.color}>{indicator.symbol} </Text>
            {session.id === activeSessionId ? (
              <Text bold underline>
                {i + 1}:{session.displayName}
              </Text>
            ) : (
              <Text dimColor>
                {i + 1}:{session.displayName}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export function Shell({
  sessions,
  activeSessionId,
  activeInstance,
  sidebarVisible,
  columns,
  rows,
}: ShellProps): React.ReactElement {
  const statusBarHeight = 1;
  const activeSessionState = sessions.find((s) => s.id === activeSessionId);

  // Responsive: if terminal is narrow, use top tabs instead of sidebar
  const useTopTabs = columns < 100;
  const showSidebar = sidebarVisible && !useTopTabs;
  const showTopTabs = sidebarVisible && useTopTabs;

  const topTabsHeight = showTopTabs ? 1 : 0;
  const mainHeight = rows - statusBarHeight - topTabsHeight;
  const mainWidth = showSidebar ? columns - SIDEBAR_WIDTH : columns;

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      {showTopTabs && (
        <TopTabs sessions={sessions} activeSessionId={activeSessionId} />
      )}

      <Box flexDirection="row" height={mainHeight}>
        {showSidebar && (
          <Sidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            width={SIDEBAR_WIDTH}
          />
        )}

        <MainPane
          session={activeInstance}
          sessionState={activeSessionState}
          width={mainWidth}
          height={mainHeight}
        />
      </Box>

      <StatusBar
        activeSession={activeSessionState}
        sessionCount={sessions.length}
      />
    </Box>
  );
}
