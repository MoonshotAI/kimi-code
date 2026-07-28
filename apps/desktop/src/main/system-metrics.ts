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
  renderer_process_count: number;
  renderer_working_set_bytes?: number;
  gpu_working_set_bytes?: number;
  other_working_set_bytes?: number;
  renderer_cpu_seconds?: number;
  gpu_cpu_seconds?: number;
  other_cpu_seconds?: number;
}

type RuntimeProcessMetric = Omit<ProcessMetric, 'memory'> & {
  readonly memory?: ProcessMetric['memory'];
};

interface ProcessMetricGroup {
  count: number;
  workingSetBytes: number;
  memoryComplete: boolean;
  cpuSeconds?: number;
}

function createProcessMetricGroup(): ProcessMetricGroup {
  return { count: 0, workingSetBytes: 0, memoryComplete: true };
}

function addProcessMetric(group: ProcessMetricGroup, metric: RuntimeProcessMetric): void {
  group.count += 1;
  const workingSetKb = metric.memory?.workingSetSize;
  if (typeof workingSetKb === 'number' && Number.isFinite(workingSetKb) && workingSetKb >= 0) {
    group.workingSetBytes += workingSetKb * 1024;
  } else {
    group.memoryComplete = false;
  }
  const cpuSeconds = metric.cpu.cumulativeCPUUsage;
  if (typeof cpuSeconds === 'number' && Number.isFinite(cpuSeconds) && cpuSeconds >= 0) {
    group.cpuSeconds = (group.cpuSeconds ?? 0) + cpuSeconds;
  }
}

export function aggregateProcessMetrics(
  metrics: readonly RuntimeProcessMetric[],
): ChromiumProcessMetrics {
  const renderer = createProcessMetricGroup();
  const gpu = createProcessMetricGroup();
  const other = createProcessMetricGroup();
  for (const metric of metrics) {
    if (metric.type === 'Browser') {
      continue;
    } else if (metric.type === 'Tab') {
      addProcessMetric(renderer, metric);
    } else if (metric.type === 'GPU') {
      addProcessMetric(gpu, metric);
    } else {
      addProcessMetric(other, metric);
    }
  }
  const result: ChromiumProcessMetrics = {
    renderer_process_count: renderer.count,
  };
  if (renderer.count === 0 || renderer.memoryComplete) {
    result.renderer_working_set_bytes = renderer.workingSetBytes;
  }
  if (gpu.count === 0 || gpu.memoryComplete) {
    result.gpu_working_set_bytes = gpu.workingSetBytes;
  }
  if (other.count === 0 || other.memoryComplete) {
    result.other_working_set_bytes = other.workingSetBytes;
  }
  if (renderer.cpuSeconds !== undefined) result.renderer_cpu_seconds = renderer.cpuSeconds;
  if (gpu.cpuSeconds !== undefined) result.gpu_cpu_seconds = gpu.cpuSeconds;
  if (other.cpuSeconds !== undefined) result.other_cpu_seconds = other.cpuSeconds;
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
    log.error(
      `[kimi-desktop] system metrics sampling failed; will retry: ${error instanceof Error ? error.message : String(error)}`,
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
