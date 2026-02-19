import { createStore } from "zustand/vanilla";

export interface PortalState {
  connectedSessionIds: Set<string>;
}

export const portalStore = createStore<PortalState>()(() => ({
  connectedSessionIds: new Set<string>(),
}));
