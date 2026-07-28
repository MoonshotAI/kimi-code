import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { appMock, windowMock, trackMock, logMock } = vi.hoisted(() => ({
  appMock: { getAppMetrics: vi.fn(() => [] as unknown[]) },
  windowMock: { getMainWindow: vi.fn(() => null as unknown) },
  trackMock: { trackDesktopEvent: vi.fn() },
  logMock: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('electron', () => ({ app: appMock }));
vi.mock('../../src/main/window', () => ({ getMainWindow: windowMock.getMainWindow }));
vi.mock('../../src/main/track', () => ({ trackDesktopEvent: trackMock.trackDesktopEvent }));
vi.mock('../../src/main/log', () => ({ log: logMock }));

import {
  aggregateProcessMetrics,
  startDesktopSystemMetrics,
  stopDesktopSystemMetrics,
} from '../../src/main/system-metrics';

function makeMetric(
  type: string,
  workingSetKb: number,
  cumulativeCPUUsage?: number,
): never {
  return {
    type,
    memory: { workingSetSize: workingSetKb, peakWorkingSetSize: workingSetKb },
    cpu: { percentCPUUsage: 0, cumulativeCPUUsage, idleWakeupsPerSecond: 0 },
  } as never;
}

function makeMetricWithoutMemory(type: string, cumulativeCPUUsage?: number): never {
  return {
    type,
    cpu: { percentCPUUsage: 0, cumulativeCPUUsage, idleWakeupsPerSecond: 0 },
  } as never;
}

function makeMainWindow(executeJavaScript: () => Promise<unknown>): never {
  return {
    isDestroyed: () => false,
    webContents: { executeJavaScript },
  } as never;
}

function lastSample(): Record<string, unknown> {
  const call = trackMock.trackDesktopEvent.mock.calls.at(-1);
  expect(call?.[0]).toBe('system_metrics');
  return call![1] as Record<string, unknown>;
}

describe('aggregateProcessMetrics', () => {
  it('aggregates renderer/GPU/other groups and converts KB to bytes, ignoring Browser', () => {
    const result = aggregateProcessMetrics([
      makeMetric('Browser', 999),
      makeMetric('Tab', 100, 1.5),
      makeMetric('Tab', 200, 0.5),
      makeMetric('GPU', 500, 2),
      makeMetric('Utility', 50, 0.25),
    ]);
    expect(result).toEqual({
      renderer_working_set_bytes: 300 * 1024,
      renderer_process_count: 2,
      gpu_working_set_bytes: 500 * 1024,
      other_working_set_bytes: 50 * 1024,
      renderer_cpu_seconds: 2,
      gpu_cpu_seconds: 2,
      other_cpu_seconds: 0.25,
    });
  });

  it('omits cpu fields when no process in the group reports cumulative usage', () => {
    const result = aggregateProcessMetrics([makeMetric('Tab', 100), makeMetric('GPU', 500, 2)]);
    expect(result.renderer_cpu_seconds).toBeUndefined();
    expect(result.gpu_cpu_seconds).toBe(2);
    expect(result.other_cpu_seconds).toBeUndefined();
  });

  it('returns zeros for an empty process list', () => {
    expect(aggregateProcessMetrics([])).toEqual({
      renderer_working_set_bytes: 0,
      renderer_process_count: 0,
      gpu_working_set_bytes: 0,
      other_working_set_bytes: 0,
    });
  });

  it('preserves process counts and CPU when Electron omits memory on Linux', () => {
    expect(
      aggregateProcessMetrics([
        makeMetricWithoutMemory('Tab', 1.5),
        makeMetricWithoutMemory('GPU', 2),
        makeMetricWithoutMemory('Utility', 0.25),
      ]),
    ).toEqual({
      renderer_process_count: 1,
      renderer_cpu_seconds: 1.5,
      gpu_cpu_seconds: 2,
      other_cpu_seconds: 0.25,
    });
  });

  it('omits a group memory total when any process in that group lacks memory', () => {
    const result = aggregateProcessMetrics([
      makeMetric('Tab', 100, 1),
      makeMetricWithoutMemory('Tab', 0.5),
    ]);

    expect(result.renderer_process_count).toBe(2);
    expect(result.renderer_working_set_bytes).toBeUndefined();
    expect(result.renderer_cpu_seconds).toBe(1.5);
  });
});

describe('desktop system metrics collector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    appMock.getAppMetrics.mockReset().mockReturnValue([]);
    windowMock.getMainWindow.mockReset().mockReturnValue(null);
    trackMock.trackDesktopEvent.mockClear();
    logMock.error.mockClear();
  });

  afterEach(() => {
    stopDesktopSystemMetrics();
    vi.useRealTimers();
  });

  it('emits a warmup sample with the CLI-mirrored main-process fields', async () => {
    startDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(trackMock.trackDesktopEvent).toHaveBeenCalledOnce();
    const sample = lastSample();
    expect(sample['rss_bytes']).toEqual(expect.any(Number));
    expect(sample['heap_used_bytes']).toEqual(expect.any(Number));
    expect(sample['heap_total_bytes']).toEqual(expect.any(Number));
    expect(sample['external_bytes']).toEqual(expect.any(Number));
    expect(sample['array_buffers_bytes']).toEqual(expect.any(Number));
    expect(sample['cpu_user_us']).toEqual(expect.any(Number));
    expect(sample['cpu_system_us']).toEqual(expect.any(Number));
    expect(sample['cpu_elapsed_us']).toEqual(expect.any(Number));
    expect(sample['process_uptime_ms']).toEqual(expect.any(Number));
    expect(sample['process_started_at']).toEqual(expect.any(Number));
    expect(sample['load_avg_1m']).toEqual(expect.any(Number));
    expect(sample['free_mem_bytes']).toEqual(expect.any(Number));
    expect(sample['total_mem_bytes']).toEqual(expect.any(Number));
    expect((sample['cpu_count'] as number) > 0).toBe(true);
    expect(sample['renderer_working_set_bytes']).toBe(0);
    expect(sample['renderer_process_count']).toBe(0);
    expect(sample['renderer_js_heap_used_bytes']).toBeUndefined();
  });

  it('does not sample before the warmup delay, then samples every 5 minutes', async () => {
    startDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(trackMock.trackDesktopEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(trackMock.trackDesktopEvent).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(trackMock.trackDesktopEvent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(trackMock.trackDesktopEvent).toHaveBeenCalledTimes(4);
  });

  it('stop prevents further samples, is idempotent, and allows a restart', async () => {
    startDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(1_500);
    stopDesktopSystemMetrics();
    stopDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(trackMock.trackDesktopEvent).toHaveBeenCalledOnce();

    startDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(trackMock.trackDesktopEvent).toHaveBeenCalledTimes(2);
  });

  it('attaches renderer JS heap read from the main window to the same event', async () => {
    windowMock.getMainWindow.mockReturnValue(
      makeMainWindow(() => Promise.resolve({ used: 1, total: 2, limit: 3 })),
    );
    startDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(1_500);

    const sample = lastSample();
    expect(sample['renderer_js_heap_used_bytes']).toBe(1);
    expect(sample['renderer_js_heap_total_bytes']).toBe(2);
    expect(sample['renderer_js_heap_limit_bytes']).toBe(3);
  });

  it('omits heap fields and keeps sampling when the renderer read rejects', async () => {
    windowMock.getMainWindow.mockReturnValue(
      makeMainWindow(() => Promise.reject(new Error('render frame gone'))),
    );
    startDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(lastSample()['renderer_js_heap_used_bytes']).toBeUndefined();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(trackMock.trackDesktopEvent).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung renderer read by the timeout and still emits the sample', async () => {
    windowMock.getMainWindow.mockReturnValue(
      makeMainWindow(() => new Promise(() => {})),
    );
    startDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(trackMock.trackDesktopEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(trackMock.trackDesktopEvent).toHaveBeenCalledOnce();
    expect(lastSample()['renderer_js_heap_used_bytes']).toBeUndefined();
  });

  it('omits heap fields for malformed renderer payloads', async () => {
    windowMock.getMainWindow.mockReturnValue(makeMainWindow(() => Promise.resolve('junk')));
    startDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(lastSample()['renderer_js_heap_used_bytes']).toBeUndefined();
  });

  it('logs a transient sampling failure and retries on the next interval', async () => {
    appMock.getAppMetrics.mockImplementationOnce(() => {
      throw new Error('metrics unavailable');
    });
    startDesktopSystemMetrics();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(logMock.error).toHaveBeenCalledOnce();
    expect(trackMock.trackDesktopEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(trackMock.trackDesktopEvent).toHaveBeenCalledOnce();
  });
});
