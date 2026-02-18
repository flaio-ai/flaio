import { createStore } from "zustand/vanilla";
import { AgentSession } from "../agents/agent-session.js";
import { getDriver } from "../agents/agent-registry.js";
import { AgentDetector, type DetectedAgent } from "../agents/agent-detector.js";
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
  detectedAgents: DetectedAgent[];

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
  adoptAgent: (agent: DetectedAgent, cols?: number, rows?: number) => Promise<AgentSession | null>;
}

// Keep actual AgentSession instances separate from serializable store state
const sessionInstances: Map<string, AgentSession> = new Map();

const agentDetector = new AgentDetector();

export const appStore = createStore<AppState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sidebarVisible: true,
  detectedAgents: [],

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

    session.on("exit", () => {
      get().closeSession(session.id);
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
      activeSessionId: session.id,
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

  adoptAgent: async (agent: DetectedAgent, cols?: number, rows?: number): Promise<AgentSession | null> => {
    const driver = getDriver(agent.driverName);
    if (!driver) return null;

    const cwd = agent.cwd ?? process.cwd();

    // Kill the external process and stop reporting it
    try {
      process.kill(agent.pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
    agentDetector.ignorePid(agent.pid);

    // Wait for the external process to fully exit before resuming
    const isAlive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    const deadline = Date.now() + 15000;
    while (isAlive(agent.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    // Extra grace period for session locks / file flush
    await new Promise((r) => setTimeout(r, 1000));

    const session = new AgentSession(driver, { cwd, cols, rows });
    sessionInstances.set(session.id, session);

    session.on("status", (status) => {
      get().updateSessionStatus(session.id, status);
    });

    session.on("content", (content) => {
      get().updateSessionContent(session.id, content);
    });

    // Don't auto-close adopted sessions — keep tab so user can see errors
    session.on("exit", () => {
      get().updateSessionStatus(session.id, "exited");
    });

    const state: SessionState = {
      id: session.id,
      driverName: driver.name,
      displayName: driver.displayName,
      cwd,
      status: "starting",
      content: [],
    };

    set((prev) => ({
      sessions: [...prev.sessions, state],
      activeSessionId: session.id,
    }));

    session.continueSession();
    return session;
  },
}));

export function getSessionInstance(sessionId: string): AgentSession | null {
  return sessionInstances.get(sessionId) ?? null;
}

agentDetector.on("change", (agents: DetectedAgent[]) => {
  // Filter out agents spawned by us
  const ownPids = new Set<number>();
  for (const instance of sessionInstances.values()) {
    const pid = instance.pid;
    if (pid) ownPids.add(pid);
  }
  const external = agents.filter((a) => !ownPids.has(a.pid));
  appStore.setState({ detectedAgents: external });
});

export function startAgentDetector(): void {
  agentDetector.start(5000);
}

export function stopAgentDetector(): void {
  agentDetector.stop();
}
