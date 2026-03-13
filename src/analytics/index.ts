export {
  initPostHog,
  identifyCliUser,
  clearCliUser,
  trackCliEvent,
  flushAndShutdown,
} from "./posthog.js";
export {
  initSentry,
  setSentryUser,
  clearSentryUser,
  startSpan,
  startSpanAsync,
  startTransaction,
} from "./sentry.js";
export { startResourceMonitor, stopResourceMonitor } from "./resource-monitor.js";
export { checkPreviousCrash, startHeartbeat, stopHeartbeat } from "./crash-recovery.js";

import { initPostHog, flushAndShutdown, identifyCliUser } from "./posthog.js";
import { initSentry, setSentryUser, closeSentry } from "./sentry.js";
import { startResourceMonitor, stopResourceMonitor } from "./resource-monitor.js";
import { checkPreviousCrash, stopHeartbeat } from "./crash-recovery.js";

export function initAnalytics(uid?: string): void {
  initSentry();
  checkPreviousCrash(); // Must be after initSentry so Sentry is ready
  initPostHog();
  startResourceMonitor();

  if (uid) {
    identifyCliUser(uid);
    setSentryUser(uid);
  }
}

export async function shutdownAnalytics(): Promise<void> {
  stopHeartbeat();
  stopResourceMonitor();
  await flushAndShutdown();
  await closeSentry();
}
