import { describe, expect, it } from 'vitest';

import { isAbortError } from '../../src/loop/errors';
import {
  abortError,
  abortable,
  isUserCancellation,
  userCancellationReason,
} from '../../src/utils/abort';

describe('userCancellationReason', () => {
  it('is recognised as a deliberate user cancellation', () => {
    expect(isUserCancellation(userCancellationReason())).toBe(true);
  });

  it('stays an AbortError so abort detection keeps treating it as an abort', () => {
    expect(isAbortError(userCancellationReason())).toBe(true);
  });

  it('is distinguishable from a generic abort, an ordinary error, and undefined', () => {
    // A generic abort (timeout, internal) must NOT read as a user cancellation —
    // that distinction is the whole point: the model needs to know a user
    // pressed stop, not that "something aborted".
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
