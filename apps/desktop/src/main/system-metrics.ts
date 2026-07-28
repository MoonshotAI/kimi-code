// Periodic host performance sampling, emitted as the `system_metrics` event.
// Mirrors the CLI v1 collector (kimi-code packages/telemetry): warmup sample
// shortly after start, then a fixed interval; sampling is main-process only —
// Chromium child processes come from app.getAppMetrics() and the renderer JS
// heap is read by injecting into the main window, so every group in one event
// shares the same sampling instant and the renderer needs no code.

import { cpus, freemem, loadavg, totalmem } from 'node:os';

import { app } from 'electron';
import type { ProcessMetric } from 'electron';

import { log } from './log';
import type { SystemMetricsEvent } from './telemetry-events';
import { trackDesktopEvent } from './track';
import { getMainWindow } from './window';

const INTERVAL_MS = 300_000;
const WARMUP_SAMPLE_MS = 1_500;
const JS_HEAP_READ_TIMEOUT_MS = 2_000;

const JS_HEAP_EXPRESSION =
  'performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null';

export interface ChromiumProcessMetrics {
  renderer_working_set_bytes: number;
  renderer_process_count: number;
  gpu_working_set_bytes: number;
  other_working_set_bytes: number;
  renderer_cpu_seconds?: number;
  gpu_cpu_seconds?: number;
  other_cpu_seconds?: number;
}

export function aggregateProcessMetrics(
  metrics: readonly ProcessMetric[],
): ChromiumProcessMetrics {
  let rendererWorkingSetBytes = 0;
  let rendererCount = 0;
  let gpuWorkingSetBytes = 0;
  let otherWorkingSetBytes = 0;
  let rendererCpuSeconds: number | undefined;
  let gpuCpuSeconds: number | undefined;
  let otherCpuSeconds: number | undefined;
  for (const metric of metrics) {
    // getAppMetrics reports working set in KB.
    const workingSetBytes = metric.memory.workingSetSize * 1024;
    const cpuSeconds = metric.cpu.cumulativeCPUUsage;
    if (metric.type === 'Tab') {
      rendererWorkingSetBytes += workingSetBytes;
      rendererCount += 1;
      if (cpuSeconds !== undefined) rendererCpuSeconds = (rendererCpuSeconds ?? 0) + cpuSeconds;
    } else if (metric.type === 'GPU') {
      gpuWorkingSetBytes += workingSetBytes;
      if (cpuSeconds !== undefined) gpuCpuSeconds = (gpuCpuSeconds ?? 0) + cpuSeconds;
    } else if (metric.type !== 'Browser') {
      // 'Browser' is the main process itself, already sampled natively.
      otherWorkingSetBytes += workingSetBytes;
      if (cpuSeconds !== undefined) otherCpuSeconds = (otherCpuSeconds ?? 0) + cpuSeconds;
    }
  }
  const result: ChromiumProcessMetrics = {
    renderer_working_set_bytes: rendererWorkingSetBytes,
    renderer_process_count: rendererCount,
    gpu_working_set_bytes: gpuWorkingSetBytes,
    other_working_set_bytes: otherWorkingSetBytes,
  };
  if (rendererCpuSeconds !== undefined) result.renderer_cpu_seconds = rendererCpuSeconds;
  if (gpuCpuSeconds !== undefined) result.gpu_cpu_seconds = gpuCpuSeconds;
  if (otherCpuSeconds !== undefined) result.other_cpu_seconds = otherCpuSeconds;
  return result;
}

let intervalTimer: ReturnType<typeof setInterval> | null = null;
let warmupTimer: ReturnType<typeof setTimeout> | null = null;
let previousCpuUsage: NodeJS.CpuUsage | null = null;
let previousHrtime: bigint | null = null;
let processStartedAtSeconds = 0;
let sampleInFlight = false;

export function startDesktopSystemMetrics(): void {
  if (intervalTimer !== null) return;
  previousCpuUsage = process.cpuUsage();
  previousHrtime = process.hrtime.bigint();
  processStartedAtSeconds = Math.floor(Date.now() / 1000 - process.uptime());
  warmupTimer = setTimeout(() => {
    warmupTimer = null;
    void sampleSafely();
  }, WARMUP_SAMPLE_MS);
  warmupTimer.unref?.();
  intervalTimer = setInterval(() => {
    void sampleSafely();
  }, INTERVAL_MS);
  intervalTimer.unref?.();
}

export function stopDesktopSystemMetrics(): void {
  if (warmupTimer !== null) {
    clearTimeout(warmupTimer);
    warmupTimer = null;
  }
  if (intervalTimer !== null) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

async function sampleSafely(): Promise<void> {
  if (sampleInFlight) return;
  sampleInFlight = true;
  try {
    await sample();
  } catch (error) {
    // Sampling must never break the host; a persistent failure just ends the
    // collection instead of throwing every interval.
    stopDesktopSystemMetrics();
    log.error(
      `[kimi-desktop] system metrics sampling failed; collector stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    sampleInFlight = false;
  }
}

async function sample(): Promise<void> {
  const now = process.hrtime.bigint();
  const elapsedUs = previousHrtime === null ? 0 : Number(now - previousHrtime) / 1_000;
  const cpu =
    previousCpuUsage === null ? { user: 0, system: 0 } : process.cpuUsage(previousCpuUsage);
  previousCpuUsage = process.cpuUsage();
  previousHrtime = now;

  const mem = process.memoryUsage();
  const properties: SystemMetricsEvent = {
    process_started_at: processStartedAtSeconds,
    process_uptime_ms: Math.round(process.uptime() * 1000),
    rss_bytes: mem.rss,
    heap_used_bytes: mem.heapUsed,
    heap_total_bytes: mem.heapTotal,
    external_bytes: mem.external,
    array_buffers_bytes: mem.arrayBuffers,
    cpu_user_us: cpu.user,
    cpu_system_us: cpu.system,
    cpu_elapsed_us: Math.round(elapsedUs),
    load_avg_1m: loadavg()[0] ?? 0,
    free_mem_bytes: freemem(),
    total_mem_bytes: totalmem(),
    cpu_count: cpus().length,
    ...aggregateProcessMetrics(app.getAppMetrics()),
  };
  const constrainedMemory = getConstrainedMemoryBytes();
  if (constrainedMemory !== undefined) properties.constrained_memory_bytes = constrainedMemory;

  const jsHeap = await readRendererJsHeap();
  if (jsHeap !== null) {
    properties.renderer_js_heap_used_bytes = jsHeap.used;
    properties.renderer_js_heap_total_bytes = jsHeap.total;
    properties.renderer_js_heap_limit_bytes = jsHeap.limit;
  }
  trackDesktopEvent('system_metrics', properties);
}

interface RendererJsHeap {
  used: number;
  total: number;
  limit: number;
}

async function readRendererJsHeap(): Promise<RendererJsHeap | null> {
  const win = getMainWindow();
  if (win === null || win.isDestroyed()) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // A hung renderer never resolves executeJavaScript — bound the wait so the
    // collector is not held up; the sample just goes out without heap fields.
    const result: unknown = await Promise.race([
      win.webContents.executeJavaScript(JS_HEAP_EXPRESSION),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), JS_HEAP_READ_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    return asRendererJsHeap(result);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function asRendererJsHeap(value: unknown): RendererJsHeap | null {
  if (typeof value !== 'object' || value === null) return null;
  const { used, total, limit } = value as Record<string, unknown>;
  if (
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    used < 0 ||
    typeof total !== 'number' ||
    !Number.isFinite(total) ||
    total < 0 ||
    typeof limit !== 'number' ||
    !Number.isFinite(limit) ||
    limit < 0
  ) {
    return null;
  }
  return { used, total, limit };
}

function getConstrainedMemoryBytes(): number | undefined {
  if (typeof process.constrainedMemory !== 'function') return undefined;
  const value = process.constrainedMemory();
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
