import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IntervalTimer } from '#/_base/utils/timer';

describe('IntervalTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the runner repeatedly on the interval', () => {
    const timer = new IntervalTimer();
    let count = 0;
    timer.cancelAndSet(() => {
      count += 1;
    }, 100);

    expect(timer.isSet()).toBe(true);
    vi.advanceTimersByTime(250);
    expect(count).toBe(2);
    timer.dispose();
  });

  it('stops firing after cancel', () => {
    const timer = new IntervalTimer();
    let count = 0;
    timer.cancelAndSet(() => {
      count += 1;
    }, 100);
    vi.advanceTimersByTime(150);
    expect(count).toBe(1);

    timer.cancel();
    expect(timer.isSet()).toBe(false);
    vi.advanceTimersByTime(200);
    expect(count).toBe(1);
  });

  it('cancelAndSet replaces a previously scheduled handle', () => {
    const timer = new IntervalTimer();
    let a = 0;
    let b = 0;
    timer.cancelAndSet(() => {
      a += 1;
    }, 100);
    timer.cancelAndSet(() => {
      b += 1;
    }, 100);

    vi.advanceTimersByTime(150);
    expect(a).toBe(0);
    expect(b).toBe(1);
    timer.dispose();
  });

  it('dispose is idempotent and stops the loop', () => {
    const timer = new IntervalTimer();
    let count = 0;
    timer.cancelAndSet(() => {
      count += 1;
    }, 100);

    timer.dispose();
    timer.dispose();
    vi.advanceTimersByTime(200);
    expect(count).toBe(0);
  });

  it('cancel on a fresh timer is a no-op', () => {
    const timer = new IntervalTimer();
    expect(() => timer.cancel()).not.toThrow();
    expect(timer.isSet()).toBe(false);
  });
});
