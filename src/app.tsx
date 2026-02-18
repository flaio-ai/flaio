import React, { useState, useCallback, useSyncExternalStore } from "react";
import { Box } from "ink";
import { Shell } from "./ui/layout/shell.js";
import { NewSessionDialog } from "./ui/components/new-session-dialog.js";
import { useTerminalSize } from "./ui/hooks/use-terminal-size.js";
import { useKeybindings } from "./ui/hooks/use-keybindings.js";
import { useRawInput } from "./ui/hooks/use-raw-input.js";
import { appStore, getSessionInstance } from "./store/app-store.js";

function useAppStore<T>(selector: (state: ReturnType<typeof appStore.getState>) => T): T {
  return useSyncExternalStore(
    appStore.subscribe,
    () => selector(appStore.getState()),
  );
}

export function App(): React.ReactElement {
  const [showNewSession, setShowNewSession] = useState(false);
  const { columns, rows } = useTerminalSize();

  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);

  const activeInstance = activeSessionId
    ? getSessionInstance(activeSessionId)
    : null;

  useKeybindings({
    onNewSession: useCallback(() => setShowNewSession(true), []),
    onCloseSession: useCallback(() => {
      const id = appStore.getState().activeSessionId;
      if (id) appStore.getState().closeSession(id);
    }, []),
  });

  useRawInput(activeInstance, !showNewSession);

  // Compute actual pane dimensions for the PTY/xterm
  const SIDEBAR_WIDTH = 24;
  const useTopTabs = columns < 100;
  const showSidebar = sidebarVisible && !useTopTabs;
  const paneWidth = showSidebar ? columns - SIDEBAR_WIDTH : columns;
  // statusBar(1) + mainPaneHeader(1) + topTabs(conditional 1)
  const chromeRows = 1 + 1 + (sidebarVisible && useTopTabs ? 1 : 0);
  const paneRows = rows - chromeRows;

  const handleNewSession = useCallback((driverName: string, cwd: string) => {
    const session = appStore.getState().createSession(driverName, cwd, paneWidth, paneRows);
    if (session) {
      session.start();
    }
    setShowNewSession(false);
  }, [paneWidth, paneRows]);

  const handleCancelNewSession = useCallback(() => {
    setShowNewSession(false);
  }, []);

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      {showNewSession ? (
        <Box
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          width={columns}
          height={rows}
        >
          <NewSessionDialog
            onSubmit={handleNewSession}
            onCancel={handleCancelNewSession}
          />
        </Box>
      ) : (
        <Shell
          sessions={sessions}
          activeSessionId={activeSessionId}
          activeInstance={activeInstance}
          sidebarVisible={sidebarVisible}
          columns={columns}
          rows={rows}
        />
      )}
    </Box>
  );
}
