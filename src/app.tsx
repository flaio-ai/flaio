import React, { useState, useCallback, useEffect, useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import { Shell } from "./ui/layout/shell.js";
import { NewSessionDialog } from "./ui/components/new-session-dialog.js";
import { SettingsPanel } from "./ui/components/settings-panel.js";
import { HelpModal } from "./ui/components/help-modal.js";
import { AdoptAgentDialog } from "./ui/components/adopt-agent-dialog.js";
import type { DetectedAgent } from "./agents/agent-detector.js";
import { useTerminalSize } from "./ui/hooks/use-terminal-size.js";
import { useKeybindings } from "./ui/hooks/use-keybindings.js";
import { useRawInput } from "./ui/hooks/use-raw-input.js";
import { usePortalConnected } from "./ui/hooks/use-portal-connected.js";
import { appStore, getSessionInstance, startAgentDetector, stopAgentDetector } from "./store/app-store.js";
import { settingsStore } from "./store/settings-store.js";
import { startConnectors, stopConnectors } from "./store/connector-store.js";

function useAppStore<T>(selector: (state: ReturnType<typeof appStore.getState>) => T): T {
  return useSyncExternalStore(
    appStore.subscribe,
    () => selector(appStore.getState()),
  );
}

export function App(): React.ReactElement {
  const [showNewSession, setShowNewSession] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAdoptDialog, setShowAdoptDialog] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sessionStartError, setSessionStartError] = useState<string | null>(null);
  const { columns, rows: rawRows } = useTerminalSize();
  // Reserve 1 row: Ink appends a trailing newline after the last line,
  // which scrolls the alt-screen buffer and pushes the first row off-screen.
  const rows = rawRows - 1;

  useEffect(() => {
    settingsStore.getState().load();
  }, []);

  useEffect(() => {
    startAgentDetector();
    return () => stopAgentDetector();
  }, []);

  useEffect(() => {
    startConnectors().catch((err) => {
      setErrorMessage(`Connector initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return () => { stopConnectors().catch(() => {}); };
  }, []);

  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const detectedAgents = useAppStore((s) => s.detectedAgents);

  const activeInstance = activeSessionId
    ? getSessionInstance(activeSessionId)
    : null;

  const portalConnected = usePortalConnected(activeSessionId);

  const toggleHelp = useCallback(() => setShowHelp((v) => !v), []);

  // Auto-dismiss the connector error banner after 5 seconds
  useEffect(() => {
    if (!errorMessage) return;
    const timer = setTimeout(() => setErrorMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [errorMessage]);

  useKeybindings({
    onNewSession: useCallback(() => setShowNewSession(true), []),
    onCloseSession: useCallback(() => {
      const id = appStore.getState().activeSessionId;
      if (id) appStore.getState().closeSession(id);
    }, []),
    onToggleSettings: useCallback(() => setShowSettings((v) => !v), []),
    onToggleHelp: toggleHelp,
    onAdoptAgent: useCallback(() => setShowAdoptDialog(true), []),
  });

  // Compute actual pane dimensions for the PTY/xterm
  const SIDEBAR_WIDTH = 24;
  const useTopTabs = columns < 100;
  const showSidebar = sidebarVisible && !useTopTabs;
  const paneWidth = (showSidebar ? columns - SIDEBAR_WIDTH : columns) - 2;
  // statusBar(1) + mainPaneHeader(3, bordered) + topTabs(conditional 3 for bordered tabs)
  const chromeRows = 1 + 3 + (sidebarVisible && useTopTabs ? 3 : 0);
  const paneRows = rows - chromeRows;

  useRawInput(activeInstance, !showNewSession && !showSettings && !showHelp && !showAdoptDialog, paneWidth, paneRows);

  useEffect(() => {
    if (paneWidth <= 0 || paneRows <= 0 || !activeSessionId) return;
    // Only resize the active session — the one the CLI user is looking at.
    // Non-active sessions with remote viewers keep the web's dimensions.
    const instance = getSessionInstance(activeSessionId);
    if (instance) {
      instance.resize(paneWidth, paneRows);
    }
  }, [paneWidth, paneRows, activeSessionId]);

  const handleNewSession = useCallback((driverName: string, cwd: string) => {
    setSessionStartError(null);
    const session = appStore.getState().createSession(driverName, cwd, paneWidth, paneRows);
    if (session) {
      session.start()
        .then(() => {
          setShowNewSession(false);
          setSessionStartError(null);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setSessionStartError(`Failed to start session: ${msg}`);
          // Clean up the failed session so it doesn't linger as a dead tab
          appStore.getState().closeSession(session.id);
        });
    } else {
      setSessionStartError("Failed to create session: driver not found");
    }
  }, [paneWidth, paneRows]);

  const handleCancelNewSession = useCallback(() => {
    setShowNewSession(false);
    setSessionStartError(null);
  }, []);

  const handleAdoptAgent = useCallback((agent: DetectedAgent) => {
    setShowAdoptDialog(false);
    appStore.getState().adoptAgent(agent, paneWidth, paneRows);
  }, [paneWidth, paneRows]);

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      {showHelp ? (
        <HelpModal onClose={() => setShowHelp(false)} />
      ) : showAdoptDialog ? (
        <AdoptAgentDialog
          agents={detectedAgents}
          onAdopt={handleAdoptAgent}
          onCancel={() => setShowAdoptDialog(false)}
        />
      ) : showNewSession ? (
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
          {sessionStartError && (
            <Box marginTop={1}>
              <Text color="red">{sessionStartError}</Text>
            </Box>
          )}
        </Box>
      ) : showSettings ? (
        <Box
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          width={columns}
          height={rows}
        >
          <SettingsPanel onClose={() => setShowSettings(false)} />
        </Box>
      ) : (
        <>
        {errorMessage && (
          <Box paddingX={1} height={1}>
            <Text color="red">{errorMessage}</Text>
          </Box>
        )}
        <Shell
          sessions={sessions}
          activeSessionId={activeSessionId}
          activeInstance={activeInstance}
          sidebarVisible={sidebarVisible}
          columns={columns}
          rows={rows}
          detectedAgents={detectedAgents}
          portalConnected={portalConnected}
        />
        </>
      )}
    </Box>
  );
}
