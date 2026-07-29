import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRuntimeLocale,
  setDesktopTrackImpl,
  setRuntimeLocale,
  trackDesktopEvent,
} from '../../src/main/track';

beforeEach(() => {
  setDesktopTrackImpl(null);
});

describe('trackDesktopEvent', () => {
  it('no-ops until an impl is installed', () => {
    expect(() =>
      trackDesktopEvent('embedded_renderer_load_result', { ok: true, duration_ms: 1 }),
    ).not.toThrow();
  });

  it('forwards events to the installed impl', () => {
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    trackDesktopEvent('app_crashed', {
      process: 'main',
      kind: 'uncaught_exception',
      error_name: 'TypeError',
      app_uptime_ms: 1,
    });
    expect(impl).toHaveBeenCalledWith('app_crashed', {
      process: 'main',
      kind: 'uncaught_exception',
      error_name: 'TypeError',
      app_uptime_ms: 1,
    });
  });

  it('no-ops again once the impl is cleared (shutdown)', () => {
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    setDesktopTrackImpl(null);
    trackDesktopEvent('app_crashed', {
      process: 'main',
      kind: 'unhandled_rejection',
      app_uptime_ms: 1,
    });
    expect(impl).not.toHaveBeenCalled();
  });

  it('buffers events fired before wiring and replays them in order on install', () => {
    trackDesktopEvent('app_launched', { launch_intent: 'normal' });
    trackDesktopEvent('startup_timing', { phase: 'main_ready', duration_ms: 10 });
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    expect(impl.mock.calls).toEqual([
      ['app_launched', { launch_intent: 'normal' }],
      ['startup_timing', { phase: 'main_ready', duration_ms: 10 }],
    ]);
    trackDesktopEvent('global_shortcut_invoked', {});
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('drops the buffered events when wiring never completes (impl cleared)', () => {
    trackDesktopEvent('app_launched', { launch_intent: 'normal' });
    setDesktopTrackImpl(null);
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    expect(impl).not.toHaveBeenCalled();
  });

  it('keeps only the newest 200 buffered events', () => {
    for (let i = 0; i < 210; i += 1) {
      trackDesktopEvent('startup_timing', { phase: 'main_ready', duration_ms: i });
    }
    const impl = vi.fn();
    setDesktopTrackImpl(impl);
    expect(impl).toHaveBeenCalledTimes(200);
    expect(impl.mock.calls[0]).toEqual([
      'startup_timing',
      { phase: 'main_ready', duration_ms: 10 },
    ]);
  });
});

describe('runtime locale', () => {
  it('stores the pushed locale, defaulting to undefined', () => {
    expect(getRuntimeLocale()).toBeUndefined();
    setRuntimeLocale('zh');
    expect(getRuntimeLocale()).toBe('zh');
    setRuntimeLocale(undefined);
    expect(getRuntimeLocale()).toBeUndefined();
  });
});
