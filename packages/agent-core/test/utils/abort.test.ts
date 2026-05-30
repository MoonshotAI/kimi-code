import { describe, expect, it } from 'vitest';

import { isAbortError } from '../../src/loop/errors';
import { abortError, isUserCancellation, userCancellationReason } from '../../src/utils/abort';

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
});
