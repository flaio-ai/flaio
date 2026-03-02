import { createStore } from "zustand/vanilla";

// ---------------------------------------------------------------------------
// Relay connection state — reactive state for the UI
// ---------------------------------------------------------------------------

export type RelayConnectionStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "error";

export type SessionEncryptionStatus = "none" | "key-exchange" | "active" | "failed";

export interface RelayState {
  /** Current WebSocket connection status */
  connectionStatus: RelayConnectionStatus;
  /** Error message if connectionStatus is "error" */
  errorMessage: string | null;
  /** Number of browser viewers currently connected across all sessions */
  totalViewerCount: number;
  /** Per-session viewer counts */
  sessionViewerCounts: Map<string, number>;
  /** Whether the user is logged in (has auth token) */
  isLoggedIn: boolean;
  /** Per-session E2E encryption status */
  sessionEncryptionStatus: Map<string, SessionEncryptionStatus>;
}

export const relayStore = createStore<RelayState>(() => ({
  connectionStatus: "disconnected",
  errorMessage: null,
  totalViewerCount: 0,
  sessionViewerCounts: new Map(),
  isLoggedIn: false,
  sessionEncryptionStatus: new Map(),
}));

export function setRelayConnectionStatus(
  status: RelayConnectionStatus,
  errorMessage?: string,
): void {
  relayStore.setState({
    connectionStatus: status,
    errorMessage: errorMessage ?? null,
  });
}

export function updateViewerCount(
  sessionId: string,
  delta: number,
): void {
  const state = relayStore.getState();
  const counts = new Map(state.sessionViewerCounts);
  const current = counts.get(sessionId) ?? 0;
  const next = Math.max(0, current + delta);

  if (next === 0) {
    counts.delete(sessionId);
  } else {
    counts.set(sessionId, next);
  }

  let total = 0;
  for (const c of counts.values()) total += c;

  relayStore.setState({
    sessionViewerCounts: counts,
    totalViewerCount: total,
  });
}

export function clearViewerCounts(): void {
  relayStore.setState({
    totalViewerCount: 0,
    sessionViewerCounts: new Map(),
  });
}

export function setSessionEncryptionStatus(
  sessionId: string,
  status: SessionEncryptionStatus,
): void {
  const statuses = new Map(relayStore.getState().sessionEncryptionStatus);
  if (status === "none") {
    statuses.delete(sessionId);
  } else {
    statuses.set(sessionId, status);
  }
  relayStore.setState({ sessionEncryptionStatus: statuses });
}

export function setRelayLoggedIn(loggedIn: boolean): void {
  relayStore.setState({ isLoggedIn: loggedIn });
}
