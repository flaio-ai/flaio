export {
  initPostHog,
  identifyCliUser,
  clearCliUser,
  trackCliEvent,
  flushAndShutdown,
} from "./posthog.js";
export { initSentry, setSentryUser, clearSentryUser } from "./sentry.js";
export { startResourceMonitor, stopResourceMonitor } from "./resource-monitor.js";

import { initPostHog, flushAndShutdown, identifyCliUser } from "./posthog.js";
import { initSentry, setSentryUser } from "./sentry.js";
import { startResourceMonitor, stopResourceMonitor } from "./resource-monitor.js";

export function initAnalytics(uid?: string): void {
  initPostHog();
  initSentry();
  startResourceMonitor();

  if (uid) {
    identifyCliUser(uid);
    setSentryUser(uid);
  }
}

export async function shutdownAnalytics(): Promise<void> {
  stopResourceMonitor();
  await flushAndShutdown();
}
