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

  // No profiling — the CLI is a long-running process and profiling
  // accumulates memory indefinitely. Use dev:debug-heap for profiling.
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "production",
    tracesSampleRate: 1.0,
    beforeSend(event) {
      const mem = process.memoryUsage();
      event.extra = {
        ...event.extra,
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        uptimeHours: Math.round((process.uptime() / 3600) * 100) / 100,
      };
      return event;
    },
  });

  process.on("uncaughtException", (err) => {
    Sentry.captureException(err);
    trackCliEvent("cli_error", {
      error: err.message,
      type: "uncaughtException",
    });
    // Flush synchronously so the event reaches Sentry before the process dies
    void Sentry.flush(2000).finally(() => {
      process.exit(1);
    });
  });

  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason);
    trackCliEvent("cli_error", {
      error: reason instanceof Error ? reason.message : String(reason),
      type: "unhandledRejection",
    });
    // Flush so the event actually reaches Sentry
    void Sentry.flush(2000);
  });

  // V8 sends SIGABRT on heap exhaustion — this IS catchable (unlike SIGKILL)
  process.on("SIGABRT", () => {
    const mem = process.memoryUsage();
    Sentry.captureMessage("CLI received SIGABRT (likely V8 OOM)", {
      level: "fatal",
      extra: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        uptimeHours: Math.round((process.uptime() / 3600) * 100) / 100,
      },
    });
    void Sentry.flush(2000);
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

// ---------------------------------------------------------------------------
// Span instrumentation helpers
// ---------------------------------------------------------------------------

export function startSpan<T>(
  name: string,
  op: string,
  fn: (span: Sentry.Span) => T,
): T {
  return Sentry.startSpan({ name, op }, fn);
}

export async function startSpanAsync<T>(
  name: string,
  op: string,
  fn: (span: Sentry.Span) => Promise<T>,
): Promise<T> {
  return Sentry.startSpan({ name, op }, fn);
}

/** Fire-and-forget span for long-running operations (sessions, connections). */
export function startTransaction(name: string, op: string): Sentry.Span {
  return Sentry.startInactiveSpan({ name, op, forceTransaction: true });
}

/** Drain Sentry transport buffers during clean shutdown. */
export async function closeSentry(): Promise<void> {
  await Sentry.close(5000);
}
