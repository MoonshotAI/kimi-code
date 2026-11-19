import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionOpenBaseline } from '../src/lib/perfTracking';

const trackMock = vi.fn();

type LongtaskCallback = (list: { getEntries(): Array<{ duration: number }> }) => void;

function installPerfEnv(opts?: { longtaskSupported?: boolean }) {
  let now = 0;
  const observers: LongtaskCallback[] = [];
  class FakePerformanceObserver {
    static supportedEntryTypes = opts?.longtaskSupported === false ? ['mark', 'measure'] : ['longtask'];
    constructor(private readonly callback: LongtaskCallback) {}
    observe() {
      observers.push(this.callback);
    }
  }
  vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    advance: (ms: number) => {
      now += ms;
    },
    observerStartCount: () => observers.length,
    emitLongtask: (duration: number) => {
      for (const callback of observers) callback({ getEntries: () => [{ duration }] });
    },
  };
}

function captureFrames(): Array<() => void> {
  const frames: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  return frames;
}

async function loadPerfTracking() {
  vi.resetModules();
  const { setProductTracker } = await import('../src/contracts');
  setProductTracker({ track: trackMock });
  return import('../src/lib/perfTracking');
}

function baselineOptions(overrides?: Partial<SessionOpenBaseline>): SessionOpenBaseline {
  return {
    cached: false,
    baseline: Promise.resolve(),
    isLoaded: () => true,
    isCurrent: () => true,
    ...overrides,
  };
}

describe('perfTracking', () => {
  beforeEach(() => {
    trackMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('session busy windows', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('aggregates longtasks and reports every window after the merge gap', async () => {
      const env = installPerfEnv();
      const perf = await loadPerfTracking();

      expect(env.observerStartCount()).toBe(0);
      perf.openSessionBusyWindow('s1');
      env.advance(100);
      env.emitLongtask(80);
      env.advance(200);
      env.emitLongtask(120);
      env.advance(700);
      perf.closeSessionBusyWindow();
      vi.advanceTimersByTime(1_999);
      expect(trackMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      perf.openSessionBusyWindow('s2');
      env.advance(500);
      perf.closeSessionBusyWindow();
      vi.advanceTimersByTime(2_000);

      expect(env.observerStartCount()).toBe(1);
      expect(trackMock.mock.calls).toEqual([
        ['session_busy_longtasks', { session_id: 's1', longtask_count: 2, longtask_total_ms: 200, longtask_max_ms: 120, busy_duration_ms: 1000 }],
        ['session_busy_longtasks', { session_id: 's2', longtask_count: 0, longtask_total_ms: 0, longtask_max_ms: 0, busy_duration_ms: 500 }],
      ]);
    });

    it('merges a reopen of the same session within the gap into one window', async () => {
      const env = installPerfEnv();
      const perf = await loadPerfTracking();

      perf.openSessionBusyWindow('s1');
      env.advance(100);
      env.emitLongtask(80);
      perf.closeSessionBusyWindow();
      env.advance(500);
      env.emitLongtask(300);
      vi.advanceTimersByTime(500);
      perf.openSessionBusyWindow('s1');
      env.advance(400);
      env.emitLongtask(60);
      perf.closeSessionBusyWindow();
      vi.advanceTimersByTime(2_000);

      expect(trackMock.mock.calls).toEqual([
        ['session_busy_longtasks', { session_id: 's1', longtask_count: 2, longtask_total_ms: 140, longtask_max_ms: 80, busy_duration_ms: 1000 }],
      ]);
    });

    it('reports the previous window immediately when another session opens', async () => {
      const env = installPerfEnv();
      const perf = await loadPerfTracking();

      perf.openSessionBusyWindow('s1');
      env.advance(100);
      perf.closeSessionBusyWindow();
      env.advance(300);
      perf.openSessionBusyWindow('s2');
      env.advance(200);
      perf.openSessionBusyWindow('s3');
      vi.advanceTimersByTime(2_000);

      expect(trackMock.mock.calls.map(([, props]) => [props.session_id, props.busy_duration_ms])).toEqual([
        ['s1', 100],
        ['s2', 200],
      ]);
    });

    it('opens no window when longtask entries are unsupported', async () => {
      const env = installPerfEnv({ longtaskSupported: false });
      const perf = await loadPerfTracking();

      perf.openSessionBusyWindow('s1');
      env.advance(500);
      perf.closeSessionBusyWindow();
      vi.advanceTimersByTime(2_000);

      expect(trackMock).not.toHaveBeenCalled();
      expect(env.observerStartCount()).toBe(0);
    });
  });

  describe('startSessionOpenTiming', () => {
    it('reports duration and cached flag on the frame after the baseline loads', async () => {
      const env = installPerfEnv();
      const frames = captureFrames();
      const perf = await loadPerfTracking();

      const complete = perf.startSessionOpenTiming('s1');
      env.advance(200);
      complete(baselineOptions({ cached: true }));
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(trackMock).not.toHaveBeenCalled();
      env.advance(50);
      frames[0]!();

      expect(trackMock).toHaveBeenCalledWith('session_open_timing', {
        session_id: 's1',
        duration_ms: 250,
        cached: true,
      });
    });

    it('yields without reporting when the baseline ends without messages', async () => {
      installPerfEnv();
      const perf = await loadPerfTracking();

      perf.startSessionOpenTiming('s1')(baselineOptions({ isLoaded: () => false }));

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(trackMock).not.toHaveBeenCalled();
    });

    it('drops the report once the session is no longer current', async () => {
      installPerfEnv();
      const frames = captureFrames();
      const perf = await loadPerfTracking();
      let current = true;

      perf.startSessionOpenTiming('s1')(baselineOptions({ isCurrent: () => current }));
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      current = false;
      frames[0]!();

      expect(trackMock).not.toHaveBeenCalled();
    });

    it('falls back to a macrotask when requestAnimationFrame is unavailable', async () => {
      installPerfEnv();
      vi.stubGlobal('requestAnimationFrame', undefined);
      const perf = await loadPerfTracking();

      perf.startSessionOpenTiming('s1')(baselineOptions());

      await vi.waitFor(() => expect(trackMock).toHaveBeenCalledOnce());
    });
  });
});
