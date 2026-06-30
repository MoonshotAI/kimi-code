import { afterEach, describe, expect, it, vi } from 'vitest';

import { scheduleHeadlessForceExit } from '#/cli/headless-exit';

describe('scheduleHeadlessForceExit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('force-exits with the lazily-resolved exit code after the grace period', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    let code = 0;
    const handle = scheduleHeadlessForceExit({ exit }, () => code, 2000);
    // The exit code can be set after scheduling (e.g. a goal turn maps its
    // terminal status to process.exitCode); it must be read at fire time.
    code = 7;

    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(7);

    clearTimeout(handle);
  });

  it('schedules an unref\'d timer so a healthy run still exits naturally', () => {
    // Real timers: an un-unref'd guard would itself keep the event loop alive,
    // turning the fix into a regression (every healthy run would wait the full
    // grace before exiting). hasRef() must be false.
    const exit = vi.fn();
    const handle = scheduleHeadlessForceExit({ exit }, () => 0, 60_000);
    expect((handle as { hasRef?: () => boolean }).hasRef?.()).toBe(false);
    clearTimeout(handle);
  });

  it('does not fire once cancelled via clearTimeout', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const handle = scheduleHeadlessForceExit({ exit }, () => 0, 2000);
    clearTimeout(handle);
    vi.advanceTimersByTime(5000);
    expect(exit).not.toHaveBeenCalled();
  });
});
