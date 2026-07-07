import { cpus, freemem, loadavg, totalmem } from 'node:os';

import type { TelemetryProperties } from './types';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_WARMUP_SAMPLE_MS = 1_500;
const SYSTEM_METRICS_EVENT = 'system_metrics';

export interface SystemMetricsTrackClient {
  track(event: string, properties?: TelemetryProperties): void;
}

export interface SystemMetricsCollectorOptions {
  readonly client: SystemMetricsTrackClient;
  readonly intervalMs?: number;
  readonly warmupSampleMs?: number | null;
}

export class SystemMetricsCollector {
  private readonly client: SystemMetricsTrackClient;
  private readonly intervalMs: number;
  private readonly warmupSampleMs: number | null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private previousCpuUsage = process.cpuUsage();
  private previousHrtime = process.hrtime.bigint();
  private readonly processStartedAtSeconds = Math.floor(Date.now() / 1000 - process.uptime());

  constructor(options: SystemMetricsCollectorOptions) {
    this.client = options.client;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.warmupSampleMs =
      options.warmupSampleMs === undefined ? DEFAULT_WARMUP_SAMPLE_MS : options.warmupSampleMs;
  }

  start(): void {
    if (this.intervalTimer !== null) return;

    if (this.warmupSampleMs !== null && this.warmupSampleMs > 0) {
      this.warmupTimer = setTimeout(() => {
        this.warmupTimer = null;
        this.sampleSafely();
      }, this.warmupSampleMs);
      this.warmupTimer.unref?.();
    }

    this.intervalTimer = setInterval(() => {
      this.sampleSafely();
    }, this.intervalMs);
    this.intervalTimer.unref?.();
  }

  stop(): void {
    if (this.warmupTimer !== null) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private sampleSafely(): void {
    try {
      this.sample();
    } catch {
      this.stop();
    }
  }

  private sample(): void {
    const now = process.hrtime.bigint();
    const elapsedUs = Number(now - this.previousHrtime) / 1_000;

    const cpu = process.cpuUsage(this.previousCpuUsage);
    this.previousCpuUsage = process.cpuUsage();
    this.previousHrtime = now;

    const mem = process.memoryUsage();
    const constrainedMemory = getConstrainedMemoryBytes();

    this.client.track(SYSTEM_METRICS_EVENT, {
      process_started_at: this.processStartedAtSeconds,
      process_uptime_ms: Math.round(process.uptime() * 1000),
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
      external_bytes: mem.external,
      array_buffers_bytes: mem.arrayBuffers,
      constrained_memory_bytes: constrainedMemory,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      cpu_elapsed_us: Math.round(elapsedUs),
      load_avg_1m: loadavg()[0],
      free_mem_bytes: freemem(),
      total_mem_bytes: totalmem(),
      cpu_count: cpus().length,
    });
  }
}

function getConstrainedMemoryBytes(): number | undefined {
  if (typeof process.constrainedMemory !== 'function') return undefined;
  const value = process.constrainedMemory();
  return Number.isFinite(value) ? value : undefined;
}
