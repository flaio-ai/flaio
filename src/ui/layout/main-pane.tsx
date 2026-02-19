import React from "react";
import os from "node:os";
import { Box, Text } from "ink";
import { TerminalView } from "../components/terminal-view.js";
import { useGitInfo } from "../hooks/use-git-info.js";
import type { AgentSession } from "../../agents/agent-session.js";
import type { SessionState } from "../../store/app-store.js";

const AGENT_ICONS: Record<string, string> = {
  claude: "◈",
  gemini: "◆",
};
const DEFAULT_ICON = "●";

const AGENT_COLORS: Record<string, string> = {
  claude: "#D97757",
  gemini: "cyan",
};
const DEFAULT_COLOR = "white";

function shortenPath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath === home) return "~";
  if (fullPath.startsWith(home + "/")) return "~" + fullPath.slice(home.length);
  return fullPath;
}

interface MainPaneProps {
  session: AgentSession | null;
  sessionState: SessionState | undefined;
  width: number;
  height: number;
  portalConnected: boolean;
}

export function MainPane({
  session,
  sessionState,
  width,
  height,
  portalConnected,
}: MainPaneProps): React.ReactElement {
  const headerHeight = 3; // 1 content + 2 border rows
  const termHeight = height - headerHeight;
  const gitInfo = useGitInfo(sessionState?.cwd ?? null);

  const icon = sessionState
    ? (AGENT_ICONS[sessionState.driverName] ?? DEFAULT_ICON)
    : DEFAULT_ICON;
  const iconColor = sessionState
    ? (AGENT_COLORS[sessionState.driverName] ?? DEFAULT_COLOR)
    : DEFAULT_COLOR;

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {/* Bordered header */}
      <Box
        borderStyle="round"
        borderColor="gray"
        width={width}
      >
        {sessionState ? (
          <Box justifyContent="space-between" width="100%">
            <Box>
              <Text color={iconColor}>{icon} </Text>
              <Text bold>{sessionState.displayName}</Text>
              <Text dimColor>  {shortenPath(sessionState.cwd)}</Text>
            </Box>
            <Box>
              {gitInfo && (
                <>
                  <Text color="#F78166"> {gitInfo.branch}</Text>
                  {gitInfo.ahead > 0 && <Text color="#3FB950"> ↑{gitInfo.ahead}</Text>}
                  {gitInfo.behind > 0 && <Text color="#F85149"> ↓{gitInfo.behind}</Text>}
                  {gitInfo.changes > 0 && <Text color="#D29922"> ✎{gitInfo.changes}</Text>}
                </>
              )}
              {portalConnected && <Text color="cyan"> ⇄</Text>}
            </Box>
          </Box>
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
