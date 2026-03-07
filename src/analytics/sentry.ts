import * as Sentry from "@sentry/node";
import { settingsStore } from "../store/settings-store.js";
import { trackCliEvent } from "./posthog.js";

const SENTRY_DSN =
  "https://7c3de148f81b5fe42bc502f155e57014@o4511000120393728.ingest.de.sentry.io/4511000599789648";

function isCrashReportsEnabled(): boolean {
  if (process.env.FLAIO_CRASH_REPORTS === "off") return false;
  const { config } = settingsStore.getState();
  return config.telemetry?.crashReports !== false;
}

export function initSentry(): void {
  if (!isCrashReportsEnabled()) return;

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "production",
    tracesSampleRate: 0,
  });

  process.on("uncaughtException", (err) => {
    Sentry.captureException(err);
    trackCliEvent("cli_error", {
      error: err.message,
      type: "uncaughtException",
    });
  });

  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason);
    trackCliEvent("cli_error", {
      error: reason instanceof Error ? reason.message : String(reason),
      type: "unhandledRejection",
    });
  });
}

export function setSentryUser(uid: string): void {
  Sentry.setUser({ id: uid });
}

export function clearSentryUser(): void {
  Sentry.setUser(null);
}

export function captureException(err: unknown): void {
  if (!isCrashReportsEnabled()) return;
  Sentry.captureException(err);
}
