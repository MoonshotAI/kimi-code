/**
 * Covers abort classification and promise ownership for abort-signal helpers.
 *
 * Uses real AbortController and Node rejection events. Run with:
 * pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/_base/utils/abort.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  abortError,
  abortable,
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

  it('observes the source rejection when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    controller.abort(reason);
    const sourceError = new Error('source failed');
    let rejectSource: (reason: unknown) => void = () => {};
    const source = new Promise<never>((_resolve, reject) => {
      rejectSource = reject;
    });
    let sourceWasUnhandled = false;
    const onUnhandledRejection = (_reason: unknown, promise: Promise<unknown>): void => {
      if (promise === source) sourceWasUnhandled = true;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await expect(abortable(source, controller.signal)).rejects.toBe(reason);
      rejectSource(sourceError);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(sourceWasUnhandled).toBe(false);
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
