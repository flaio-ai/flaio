import { createStore } from "zustand/vanilla";
import { AgentSession } from "../agents/agent-session.js";
import { getDriver } from "../agents/agent-registry.js";
import { AgentDetector, type DetectedAgent } from "../agents/agent-detector.js";
import type { AgentStatus } from "../agents/drivers/base-driver.js";
import type { DetailedStatus } from "../agents/sideband/status-resolver.js";

export interface SessionState {
  id: string;
  driverName: string;
  displayName: string;
  cwd: string;
  status: AgentStatus;
  /** Whether this session is interactive (TUI) or non-interactive (print mode) */
  interactive?: boolean;
  /** The CLI command string that was used to spawn this session */
  command?: string;
  /** Rich status from sideband hooks */
  detailedStatus?: DetailedStatus;
  /** Current tool being used (from hook events) */
  currentTool?: string;
  /** Model ID e.g. "claude-opus-4-6" (from status line metadata) */
  modelId?: string;
  /** Model display name (from status line metadata) */
  modelDisplayName?: string;
  /** Cumulative cost in USD (from status line metadata) */
  totalCostUsd?: number;
  /** Context window usage percentage 0-100 (from status line metadata) */
  usedPercentage?: number;
  /** Lines added this session */
  totalLinesAdded?: number;
  /** Lines removed this session */
  totalLinesRemoved?: number;
}

export interface AppState {
  sessions: SessionState[];
  activeSessionId: string | null;
  sidebarVisible: boolean;
  detectedAgents: DetectedAgent[];

  // Actions
  createSession: (driverName: string, cwd: string, cols?: number, rows?: number, scrollback?: number) => AgentSession | null;
  closeSession: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  nextSession: () => void;
  prevSession: () => void;
  toggleSidebar: () => void;
  getActiveSession: () => AgentSession | null;
  updateSessionStatus: (sessionId: string, status: AgentStatus) => void;
  updateSessionDetailed: (sessionId: string, detailed: DetailedStatus, toolName?: string) => void;
  updateSessionMetadata: (sessionId: string, meta: { modelId?: string; modelDisplayName?: string; totalCostUsd?: number; usedPercentage?: number; totalLinesAdded?: number; totalLinesRemoved?: number }) => void;
  setSessionMeta: (sessionId: string, meta: { interactive?: boolean; command?: string }) => void;
  adoptAgent: (agent: DetectedAgent, cols?: number, rows?: number) => Promise<AgentSession | null>;
}

// Keep actual AgentSession instances separate from serializable store state
const sessionInstances: Map<string, AgentSession> = new Map();

// Permission-pending guard: while a session is in this set, the driver's
// "running" poll is suppressed so it can't overwrite "waiting_permission".
// Unlike a full lock, non-running transitions (waiting_input, exited) are
// allowed through and auto-clear the guard — this prevents stuck badges
// even if the connector's requestPermission() never settles.
const permissionPending = new Set<string>();

export function setPermissionPending(sessionId: string): void {
  permissionPending.add(sessionId);
}

export function clearPermissionPending(sessionId: string): void {
  permissionPending.delete(sessionId);
}

const agentDetector = new AgentDetector();

export const appStore = createStore<AppState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sidebarVisible: true,
  detectedAgents: [],

  createSession: (driverName: string, cwd: string, cols?: number, rows?: number, scrollback?: number): AgentSession | null => {
    const driver = getDriver(driverName);
    if (!driver) return null;

    const session = new AgentSession(driver, { cwd, cols, rows, scrollback });
    sessionInstances.set(session.id, session);

    session.on("status", (status) => {
      get().updateSessionStatus(session.id, status);
    });

    session.on("detailed_status", (detailed: DetailedStatus, toolName?: string) => {
      get().updateSessionDetailed(session.id, detailed, toolName);
    });

    session.on("metadata", (metadata: { modelId?: string; modelDisplayName?: string; totalCostUsd?: number; totalLinesAdded?: number; totalLinesRemoved?: number; contextWindow?: { usedPercentage?: number } }) => {
      get().updateSessionMetadata(session.id, {
        modelId: metadata.modelId,
        modelDisplayName: metadata.modelDisplayName,
        totalCostUsd: metadata.totalCostUsd,
        usedPercentage: metadata.contextWindow?.usedPercentage,
        totalLinesAdded: metadata.totalLinesAdded,
        totalLinesRemoved: metadata.totalLinesRemoved,
      });
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
    permissionPending.delete(sessionId);

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

  setSessionMeta: (sessionId: string, meta: { interactive?: boolean; command?: string }) => {
    set((prev) => ({
      sessions: prev.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...meta } : s,
      ),
    }));
  },

  updateSessionDetailed: (sessionId: string, detailed: DetailedStatus, toolName?: string) => {
    // When sideband reports a state other than waiting_permission,
    // clear the permission guard so updateSessionStatus isn't blocked
    if (detailed.state !== "waiting_permission" && permissionPending.has(sessionId)) {
      permissionPending.delete(sessionId);
    }
    // Skip no-op updates
    const current = get().sessions.find((s) => s.id === sessionId);
    if (current?.detailedStatus?.state === detailed.state && current?.currentTool === toolName) return;
    set((prev) => ({
      sessions: prev.sessions.map((s) =>
        s.id === sessionId ? { ...s, detailedStatus: detailed, currentTool: toolName } : s,
      ),
    }));
  },

  updateSessionMetadata: (sessionId: string, meta: { modelId?: string; modelDisplayName?: string; totalCostUsd?: number; usedPercentage?: number; totalLinesAdded?: number; totalLinesRemoved?: number }) => {
    set((prev) => ({
      sessions: prev.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...meta } : s,
      ),
    }));
  },

  updateSessionStatus: (sessionId: string, status: AgentStatus) => {
    if (permissionPending.has(sessionId)) {
      // During a pending permission, suppress the driver's "running" poll
      // so it can't overwrite the "waiting_permission" badge.
      // Other transitions (waiting_input, exited) mean the agent moved on
      // — auto-clear the guard and let the update through.
      if (status === "running") return;
      permissionPending.delete(sessionId);
    }
    // Skip no-op updates to avoid unnecessary state churn + subscriber callbacks
    const current = get().sessions.find((s) => s.id === sessionId);
    if (current?.status === status) return;
    set((prev) => ({
      sessions: prev.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s,
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

    session.on("detailed_status", (detailed: DetailedStatus, toolName?: string) => {
      get().updateSessionDetailed(session.id, detailed, toolName);
    });

    session.on("metadata", (metadata: { modelId?: string; modelDisplayName?: string; totalCostUsd?: number; totalLinesAdded?: number; totalLinesRemoved?: number; contextWindow?: { usedPercentage?: number } }) => {
      get().updateSessionMetadata(session.id, {
        modelId: metadata.modelId,
        modelDisplayName: metadata.modelDisplayName,
        totalCostUsd: metadata.totalCostUsd,
        usedPercentage: metadata.contextWindow?.usedPercentage,
        totalLinesAdded: metadata.totalLinesAdded,
        totalLinesRemoved: metadata.totalLinesRemoved,
      });
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
    };

    set((prev) => ({
      sessions: [...prev.sessions, state],
      activeSessionId: session.id,
    }));

    await session.continueSession();
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
