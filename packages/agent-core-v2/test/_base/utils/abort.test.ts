import { describe, expect, it } from 'vitest';

import {
  abortError,
  abortable,
  createIdleTimeoutAbortSignal,
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from '#/_base/utils/abort';
import { MAX_TIMER_DELAY_MS } from '#/_base/utils/timer';

import { ManualTimeoutScheduler } from './stubs';

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
  it('aborts the synthesized signal once the idle timeout elapses', async () => {
    const scheduler = new ManualTimeoutScheduler();
    const idle = createIdleTimeoutAbortSignal(undefined, 1000, scheduler);

    expect(scheduler.scheduledTimeoutMs()).toBe(1000);
    await scheduler.advance(999);
    expect(idle.signal.aborted).toBe(false);
    await scheduler.advance(1);

    expect(idle.signal.aborted).toBe(true);
    expect(idle.idleTimedOut()).toBe(true);
    expect(isAbortError(idle.signal.reason)).toBe(true);
    idle.clear();
  });

  it('restarts the countdown on every touch', async () => {
    const scheduler = new ManualTimeoutScheduler();
    const idle = createIdleTimeoutAbortSignal(undefined, 1000, scheduler);

    await scheduler.advance(900);
    idle.touch();
    await scheduler.advance(900);
    expect(idle.signal.aborted).toBe(false);
    await scheduler.advance(100);

    expect(idle.signal.aborted).toBe(true);
    expect(idle.idleTimedOut()).toBe(true);
  });

  it('switches the countdown duration when touch passes one', async () => {
    const scheduler = new ManualTimeoutScheduler();
    const idle = createIdleTimeoutAbortSignal(undefined, 10_000, scheduler);

    idle.touch(100);
    expect(scheduler.scheduledTimeoutMs()).toBe(100);
    await scheduler.advance(100);

    expect(idle.signal.aborted).toBe(true);
    expect(idle.idleTimedOut()).toBe(true);
  });

  it('disarms when touch passes a non-positive duration', async () => {
    const scheduler = new ManualTimeoutScheduler();
    const idle = createIdleTimeoutAbortSignal(undefined, 1000, scheduler);

    idle.touch(0);

    expect(scheduler.size).toBe(0);
    await scheduler.advance(60_000);
    expect(idle.signal.aborted).toBe(false);
    idle.clear();
  });

  it('propagates a parent abort with its reason and stays distinguishable from an idle timeout', () => {
    const scheduler = new ManualTimeoutScheduler();
    const controller = new AbortController();
    const idle = createIdleTimeoutAbortSignal(controller.signal, 1000, scheduler);
    const reason = userCancellationReason();

    controller.abort(reason);

    expect(idle.signal.aborted).toBe(true);
    expect(idle.signal.reason).toBe(reason);
    expect(idle.idleTimedOut()).toBe(false);
    idle.clear();
  });

  it('stops the timer and unlinks the parent on clear', () => {
    const scheduler = new ManualTimeoutScheduler();
    const controller = new AbortController();
    const idle = createIdleTimeoutAbortSignal(controller.signal, 1000, scheduler);
    expect(scheduler.size).toBe(1);

    idle.clear();

    expect(scheduler.size).toBe(0);
    controller.abort();
    expect(idle.signal.aborted).toBe(false);
  });

  it('never arms when created with a non-positive timeout', async () => {
    const scheduler = new ManualTimeoutScheduler();
    const idle = createIdleTimeoutAbortSignal(undefined, 0, scheduler);

    expect(scheduler.size).toBe(0);
    idle.touch();
    expect(scheduler.size).toBe(0);
    await scheduler.advance(60_000);
    expect(idle.signal.aborted).toBe(false);
    idle.clear();
  });

  it('ignores touches after clear', () => {
    const scheduler = new ManualTimeoutScheduler();
    const idle = createIdleTimeoutAbortSignal(undefined, 1000, scheduler);
    idle.clear();

    idle.touch();

    expect(scheduler.size).toBe(0);
    expect(idle.signal.aborted).toBe(false);
  });

  it('does not re-arm once the idle timeout has fired', async () => {
    const scheduler = new ManualTimeoutScheduler();
    const idle = createIdleTimeoutAbortSignal(undefined, 1000, scheduler);
    await scheduler.advance(1000);
    expect(idle.idleTimedOut()).toBe(true);

    idle.touch();

    expect(scheduler.size).toBe(0);
  });

  it('clamps an excessive timeout to the timer ceiling instead of firing immediately', async () => {
    const scheduler = new ManualTimeoutScheduler();
    const idle = createIdleTimeoutAbortSignal(undefined, Number.MAX_SAFE_INTEGER, scheduler);

    expect(scheduler.scheduledTimeoutMs()).toBe(MAX_TIMER_DELAY_MS);
    await scheduler.advance(MAX_TIMER_DELAY_MS - 1);
    expect(idle.signal.aborted).toBe(false);
    await scheduler.advance(1);

    expect(idle.signal.aborted).toBe(true);
    expect(idle.idleTimedOut()).toBe(true);
    idle.clear();
  });

  it('clamps an excessive timeout passed to touch', async () => {
    const scheduler = new ManualTimeoutScheduler();
    const idle = createIdleTimeoutAbortSignal(undefined, 1000, scheduler);

    idle.touch(Number.MAX_SAFE_INTEGER);

    expect(scheduler.scheduledTimeoutMs()).toBe(MAX_TIMER_DELAY_MS);
    await scheduler.advance(60_000);
    expect(idle.signal.aborted).toBe(false);
    expect(scheduler.size).toBe(1);
    idle.clear();
  });
});
