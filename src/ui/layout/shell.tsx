import React from "react";
import path from "node:path";
import { Box } from "ink";
import { Sidebar } from "./sidebar.js";
import { MainPane } from "./main-pane.js";
import { StatusBar } from "./status-bar.js";
import { AgentTab } from "../components/agent-tab.js";
import type { AgentSession } from "../../agents/agent-session.js";
import type { SessionState } from "../../store/app-store.js";

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
    <Box height={3} flexDirection="row" flexWrap="wrap">
      {sessions.map((session, i) => (
        <AgentTab
          key={session.id}
          name={path.basename(session.cwd)}
          status={session.status}
          isActive={session.id === activeSessionId}
          index={i}
        />
      ))}
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

  const topTabsHeight = showTopTabs ? 3 : 0;
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
