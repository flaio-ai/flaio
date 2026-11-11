import { monitorEventLoopDelay } from "node:perf_hooks";
import { trackCliEvent } from "./posthog.js";
import { captureException } from "./sentry.js";

const SAMPLE_INTERVAL_MS = 30_000;
const REPORT_INTERVAL_MS = 5 * 60_000;
const HEAP_ALERT_THRESHOLDS_MB = [100, 500, 1000, 2000];

let sampleTimer: ReturnType<typeof setInterval> | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;
let baselineHeap: number | null = null;
let alertedThresholds = new Set<number>();
let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let previousHeapUsed: number | null = null;
let consecutiveGrowths = 0;

// Accumulator for samples between reports
let samples: { heapUsed: number; rss: number; userCpu: number; systemCpu: number }[] = [];
let lastCpuUsage = process.cpuUsage();

export function startResourceMonitor(): void {
  if (sampleTimer) return;

  baselineHeap = process.memoryUsage().heapUsed;
  alertedThresholds = new Set();
  samples = [];
  lastCpuUsage = process.cpuUsage();

  // Monitor event loop delay (resolution: 20ms)
  eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopHistogram.enable();

  sampleTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();

    samples.push({
      heapUsed: mem.heapUsed,
      rss: mem.rss,
      userCpu: cpu.user,
      systemCpu: cpu.system,
    });

    // Progressive memory leak alerts
    if (baselineHeap !== null) {
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      for (const threshold of HEAP_ALERT_THRESHOLDS_MB) {
        if (
          !alertedThresholds.has(threshold) &&
          mem.heapUsed - baselineHeap > threshold * 1024 * 1024
        ) {
          alertedThresholds.add(threshold);
          captureException(
            new Error(
              `Memory alert: heap grew ${threshold}MB above baseline (now ${heapMB}MB)`,
            ),
          );
        }
      }

      // Sustained growth detection — 20 consecutive growth samples (~10 min)
      if (previousHeapUsed !== null) {
        if (mem.heapUsed > previousHeapUsed) {
          consecutiveGrowths++;
        } else {
          consecutiveGrowths = 0;
        }

        if (consecutiveGrowths === 20) {
          captureException(
            new Error(
              `Sustained memory growth: heap has grown for ${consecutiveGrowths} consecutive samples (${heapMB}MB)`,
            ),
          );
          consecutiveGrowths = 0; // Reset to report again later
        }
      }
      previousHeapUsed = mem.heapUsed;
    }
  }, SAMPLE_INTERVAL_MS);
  sampleTimer.unref();

  reportTimer = setInterval(() => {
    if (samples.length === 0) return;

    const avgHeap =
      samples.reduce((s, x) => s + x.heapUsed, 0) / samples.length;
    const avgRss =
      samples.reduce((s, x) => s + x.rss, 0) / samples.length;
    const totalUserCpu = samples.reduce((s, x) => s + x.userCpu, 0);
    const totalSystemCpu = samples.reduce((s, x) => s + x.systemCpu, 0);

    trackCliEvent("cli_resource_usage", {
      avgHeapMB: Math.round(avgHeap / 1024 / 1024),
      avgRssMB: Math.round(avgRss / 1024 / 1024),
      totalUserCpuMs: Math.round(totalUserCpu / 1000),
      totalSystemCpuMs: Math.round(totalSystemCpu / 1000),
      sampleCount: samples.length,
      // Event loop lag metrics (in ms)
      eventLoopP50Ms: eventLoopHistogram ? Math.round(eventLoopHistogram.percentile(50) / 1e6) : null,
      eventLoopP95Ms: eventLoopHistogram ? Math.round(eventLoopHistogram.percentile(95) / 1e6) : null,
      eventLoopP99Ms: eventLoopHistogram ? Math.round(eventLoopHistogram.percentile(99) / 1e6) : null,
      eventLoopMaxMs: eventLoopHistogram ? Math.round(eventLoopHistogram.max / 1e6) : null,
    });

    eventLoopHistogram?.reset();
    samples = [];
  }, REPORT_INTERVAL_MS);
  reportTimer.unref();
}

export function stopResourceMonitor(): void {
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
  if (eventLoopHistogram) {
    eventLoopHistogram.disable();
    eventLoopHistogram = null;
  }
  samples = [];
  baselineHeap = null;
  alertedThresholds = new Set();
  previousHeapUsed = null;
  consecutiveGrowths = 0;
}
