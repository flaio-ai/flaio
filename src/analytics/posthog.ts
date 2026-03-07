import { PostHog } from "posthog-node";
import os from "node:os";
import { createHash } from "node:crypto";
import { settingsStore } from "../store/settings-store.js";

const POSTHOG_KEY = "phc_MM65qMuiRmhUo4kV9KrwWzHxbgiUWQ4bIGSga4Sg21f";

let posthog: PostHog | null = null;
let currentDistinctId: string | null = null;

function isTelemetryEnabled(): boolean {
  if (process.env.FLAIO_TELEMETRY === "off") return false;
  const { config } = settingsStore.getState();
  return config.telemetry?.enabled !== false;
}

function getMachineId(): string {
  const raw = `${os.hostname()}:${os.homedir()}:${os.platform()}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function getDistinctId(): string {
  return currentDistinctId ?? `cli-anon-${getMachineId()}`;
}

export function initPostHog(): void {
  if (!isTelemetryEnabled()) return;

  posthog = new PostHog(POSTHOG_KEY, {
    host: "https://eu.i.posthog.com",
    flushAt: 10,
    flushInterval: 30000,
  });
}

export function identifyCliUser(uid: string): void {
  currentDistinctId = uid;
  if (!posthog || !isTelemetryEnabled()) return;

  posthog.identify({
    distinctId: uid,
    properties: {
      platform: "cli",
      os: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
    },
  });
}

export function clearCliUser(): void {
  currentDistinctId = null;
}

export function trackCliEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!posthog || !isTelemetryEnabled()) return;

  posthog.capture({
    distinctId: getDistinctId(),
    event,
    properties: {
      platform: "cli",
      ...properties,
    },
  });
}

export async function flushAndShutdown(): Promise<void> {
  if (!posthog) return;
  await posthog.shutdown();
  posthog = null;
}
