import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  abortError,
  abortable,
  createIdleTimeoutAbortSignal,
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from '#/_base/utils/abort';

describe('userCancellationReason', () => {
  it('is recognised as a deliberate user cancellation', () => {
    expect(isUserCancellation(userCancellationReason())).toBe(true);
  });

  it('stays an AbortError so abort detection keeps treating it as an abort', () => {
    expect(isAbortError(userCancellationReason())).toBe(true);
  });

  it('is distinguishable from a generic abort, an ordinary error, and undefined', () => {
    expect(isUserCancellation(abortError())).toBe(false);
    expect(isUserCancellation(new Error('boom'))).toBe(false);
    expect(isUserCancellation(undefined)).toBe(false);
  });

  it('keeps custom system abort messages classified as AbortError', () => {
    expect(abortError('Session closed')).toMatchObject({
      name: 'AbortError',
      message: 'Session closed',
    });
  });
});

describe('abortable', () => {
  it('rejects with the signal reason when already aborted', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    controller.abort(reason);

    await expect(abortable(Promise.resolve('ok'), controller.signal)).rejects.toBe(reason);
  });

  it('rejects with the signal reason when aborted while pending', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    const pending = new Promise<never>(() => {});
    const result = abortable(pending, controller.signal);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });

  it('normalizes the default AbortController reason to a generic AbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(abortable(Promise.resolve('ok'), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    });
  });

  it('falls back to a generic AbortError when the signal reason is not an Error', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');

    await expect(abortable(Promise.resolve('ok'), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    });
  });
});

describe('createIdleTimeoutAbortSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the synthesized signal once the idle timeout elapses', () => {
    const idle = createIdleTimeoutAbortSignal(undefined, 1000);

    vi.advanceTimersByTime(999);
    expect(idle.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);

    expect(idle.signal.aborted).toBe(true);
    expect(idle.idleTimedOut()).toBe(true);
    expect(isAbortError(idle.signal.reason)).toBe(true);
    idle.clear();
  });

  it('restarts the countdown on every touch', () => {
    const idle = createIdleTimeoutAbortSignal(undefined, 1000);

    vi.advanceTimersByTime(900);
    idle.touch();
    vi.advanceTimersByTime(900);
    expect(idle.signal.aborted).toBe(false);
    vi.advanceTimersByTime(100);

    expect(idle.signal.aborted).toBe(true);
    expect(idle.idleTimedOut()).toBe(true);
  });

  it('switches the countdown duration when touch passes one', () => {
    const idle = createIdleTimeoutAbortSignal(undefined, 10_000);

    idle.touch(100);
    vi.advanceTimersByTime(100);

    expect(idle.signal.aborted).toBe(true);
    expect(idle.idleTimedOut()).toBe(true);
  });

  it('disarms when touch passes a non-positive duration', () => {
    const idle = createIdleTimeoutAbortSignal(undefined, 1000);

    idle.touch(0);

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(idle.signal.aborted).toBe(false);
    idle.clear();
  });

  it('propagates a parent abort with its reason and stays distinguishable from an idle timeout', () => {
    const controller = new AbortController();
    const idle = createIdleTimeoutAbortSignal(controller.signal, 1000);
    const reason = userCancellationReason();

    controller.abort(reason);

    expect(idle.signal.aborted).toBe(true);
    expect(idle.signal.reason).toBe(reason);
    expect(idle.idleTimedOut()).toBe(false);
    idle.clear();
  });

  it('stops the timer and unlinks the parent on clear', () => {
    const controller = new AbortController();
    const idle = createIdleTimeoutAbortSignal(controller.signal, 1000);
    expect(vi.getTimerCount()).toBe(1);

    idle.clear();

    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(idle.signal.aborted).toBe(false);
  });

  it('never arms when created with a non-positive timeout', () => {
    const idle = createIdleTimeoutAbortSignal(undefined, 0);

    expect(vi.getTimerCount()).toBe(0);
    idle.touch();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(idle.signal.aborted).toBe(false);
    idle.clear();
  });

  it('ignores touches after clear', () => {
    const idle = createIdleTimeoutAbortSignal(undefined, 1000);
    idle.clear();

    idle.touch();

    expect(vi.getTimerCount()).toBe(0);
    expect(idle.signal.aborted).toBe(false);
  });

  it('does not re-arm once the idle timeout has fired', () => {
    const idle = createIdleTimeoutAbortSignal(undefined, 1000);
    vi.advanceTimersByTime(1000);
    expect(idle.idleTimedOut()).toBe(true);

    idle.touch();

    expect(vi.getTimerCount()).toBe(0);
  });
});
