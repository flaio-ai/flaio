import { createStore } from "zustand/vanilla";
import { AgentSession } from "../agents/agent-session.js";
import { getDriver } from "../agents/agent-registry.js";
import type { AgentStatus } from "../agents/drivers/base-driver.js";
import type { ScreenContent } from "../terminal/screen-buffer.js";

export interface SessionState {
  id: string;
  driverName: string;
  displayName: string;
  cwd: string;
  status: AgentStatus;
  content: ScreenContent;
}

export interface AppState {
  sessions: SessionState[];
  activeSessionId: string | null;
  sidebarVisible: boolean;

  // Actions
  createSession: (driverName: string, cwd: string, cols?: number, rows?: number) => AgentSession | null;
  closeSession: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  nextSession: () => void;
  prevSession: () => void;
  toggleSidebar: () => void;
  getActiveSession: () => AgentSession | null;
  updateSessionStatus: (sessionId: string, status: AgentStatus) => void;
  updateSessionContent: (sessionId: string, content: ScreenContent) => void;
}

// Keep actual AgentSession instances separate from serializable store state
const sessionInstances: Map<string, AgentSession> = new Map();

export const appStore = createStore<AppState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sidebarVisible: true,

  createSession: (driverName: string, cwd: string, cols?: number, rows?: number): AgentSession | null => {
    const driver = getDriver(driverName);
    if (!driver) return null;

    const session = new AgentSession(driver, { cwd, cols, rows });
    sessionInstances.set(session.id, session);

    session.on("status", (status) => {
      get().updateSessionStatus(session.id, status);
    });

    session.on("content", (content) => {
      get().updateSessionContent(session.id, content);
    });

    const state: SessionState = {
      id: session.id,
      driverName: driver.name,
      displayName: driver.displayName,
      cwd,
      status: "idle",
      content: [],
    };

    set((prev) => ({
      sessions: [...prev.sessions, state],
      activeSessionId: prev.activeSessionId ?? session.id,
    }));

    return session;
  },

  closeSession: (sessionId: string) => {
    const instance = sessionInstances.get(sessionId);
    if (instance) {
      instance.kill();
      sessionInstances.delete(sessionId);
    }

    set((prev) => {
      const sessions = prev.sessions.filter((s) => s.id !== sessionId);
      let activeSessionId = prev.activeSessionId;
      if (activeSessionId === sessionId) {
        activeSessionId = sessions.length > 0 ? sessions[0]!.id : null;
      }
      return { sessions, activeSessionId };
    });
  },

  switchSession: (sessionId: string) => {
    set({ activeSessionId: sessionId });
  },

  nextSession: () => {
    const { sessions, activeSessionId } = get();
    if (sessions.length === 0) return;
    const idx = sessions.findIndex((s) => s.id === activeSessionId);
    const next = (idx + 1) % sessions.length;
    set({ activeSessionId: sessions[next]!.id });
  },

  prevSession: () => {
    const { sessions, activeSessionId } = get();
    if (sessions.length === 0) return;
    const idx = sessions.findIndex((s) => s.id === activeSessionId);
    const prev = (idx - 1 + sessions.length) % sessions.length;
    set({ activeSessionId: sessions[prev]!.id });
  },

  toggleSidebar: () => {
    set((prev) => ({ sidebarVisible: !prev.sidebarVisible }));
  },

  getActiveSession: (): AgentSession | null => {
    const { activeSessionId } = get();
    if (!activeSessionId) return null;
    return sessionInstances.get(activeSessionId) ?? null;
  },

  updateSessionStatus: (sessionId: string, status: AgentStatus) => {
    set((prev) => ({
      sessions: prev.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s,
      ),
    }));
  },

  updateSessionContent: (sessionId: string, content: ScreenContent) => {
    set((prev) => ({
      sessions: prev.sessions.map((s) =>
        s.id === sessionId ? { ...s, content } : s,
      ),
    }));
  },
}));

export function getSessionInstance(sessionId: string): AgentSession | null {
  return sessionInstances.get(sessionId) ?? null;
}
