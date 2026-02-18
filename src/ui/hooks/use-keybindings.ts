import { useInput, useApp } from "ink";
import { appStore } from "../../store/app-store.js";

interface KeybindingActions {
  onNewSession: () => void;
  onCloseSession: () => void;
}

export function useKeybindings(actions: KeybindingActions): void {
  const { exit } = useApp();

  useInput((input, key) => {
    const store = appStore.getState();

    // Ctrl+Q: Quit app
    if (key.ctrl && input === "q") {
      // Close all sessions before exiting
      for (const s of store.sessions) {
        store.closeSession(s.id);
      }
      exit();
      return;
    }

    // Ctrl+C: Quit if no sessions, otherwise forward to PTY
    if (key.ctrl && input === "c") {
      if (store.sessions.length === 0) {
        exit();
        return;
      }
      // Otherwise let it pass through to the PTY via use-raw-input
      return;
    }

    // Ctrl+T: New session
    if (key.ctrl && input === "t") {
      actions.onNewSession();
      return;
    }

    // Ctrl+W: Close active session
    if (key.ctrl && input === "w") {
      actions.onCloseSession();
      return;
    }

    // Ctrl+N or Ctrl+Down: Next session
    if (key.ctrl && (input === "n" || key.downArrow)) {
      store.nextSession();
      return;
    }

    // Ctrl+P or Ctrl+Up: Previous session
    if (key.ctrl && (input === "p" || key.upArrow)) {
      store.prevSession();
      return;
    }

    // Ctrl+B: Toggle sidebar
    if (key.ctrl && input === "b") {
      store.toggleSidebar();
      return;
    }

    // Ctrl+1-9: Jump to tab N
    if (key.ctrl && input >= "1" && input <= "9") {
      const index = parseInt(input) - 1;
      const sessions = store.sessions;
      if (index < sessions.length) {
        store.switchSession(sessions[index]!.id);
      }
      return;
    }
  });
}
