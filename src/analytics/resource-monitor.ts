import { trackCliEvent } from "./posthog.js";
import { captureException } from "./sentry.js";

const SAMPLE_INTERVAL_MS = 30_000;
const REPORT_INTERVAL_MS = 5 * 60_000;
const HEAP_ALERT_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB above baseline

let sampleTimer: ReturnType<typeof setInterval> | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;
let baselineHeap: number | null = null;
let heapAlerted = false;

// Accumulator for samples between reports
let samples: { heapUsed: number; rss: number; userCpu: number; systemCpu: number }[] = [];
let lastCpuUsage = process.cpuUsage();

export function startResourceMonitor(): void {
  if (sampleTimer) return;

  baselineHeap = process.memoryUsage().heapUsed;
  heapAlerted = false;
  samples = [];
  lastCpuUsage = process.cpuUsage();

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

    // Check for memory leak
    if (
      baselineHeap !== null &&
      !heapAlerted &&
      mem.heapUsed - baselineHeap > HEAP_ALERT_THRESHOLD_BYTES
    ) {
      heapAlerted = true;
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      const baselineMB = Math.round(baselineHeap / 1024 / 1024);
      captureException(
        new Error(
          `Potential memory leak: heap grew from ${baselineMB}MB to ${heapMB}MB`,
        ),
      );
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
    });

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
  samples = [];
  baselineHeap = null;
  heapAlerted = false;
}
