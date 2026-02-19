import { useSyncExternalStore } from "react";
import { portalStore } from "../../store/portal-store.js";

export function usePortalConnected(sessionId: string | null): boolean {
  return useSyncExternalStore(
    portalStore.subscribe,
    () => {
      if (!sessionId) return false;
      return portalStore.getState().connectedSessionIds.has(sessionId);
    },
  );
}
