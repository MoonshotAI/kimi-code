import type { TurnStepRetryingEvent } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { buildRetryStatus, formatRetryLabel, retryReasonText } from '#/tui/utils/retry-status';
import type { RetryStatus } from '#/tui/types';

function makeStatus(overrides: Partial<RetryStatus> = {}): RetryStatus {
  return {
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 10,
    delayMs: 2_000,
    nextRetryAt: 10_000,
    errorName: 'Error',
    errorMessage: 'boom',
    ...overrides,
  };
}

describe('retryReasonText', () => {
  it('maps 429 to a rate-limit reason', () => {
    expect(retryReasonText({ statusCode: 429, errorName: 'x', errorMessage: 'y' })).toBe(
      'Rate limited (429)',
    );
  });

  it('maps 408 to a request-timeout reason', () => {
    expect(retryReasonText({ statusCode: 408, errorName: 'x', errorMessage: 'y' })).toBe(
      'Request timed out (408)',
    );
  });

  it('maps 5xx to a server-error reason with the code', () => {
    expect(retryReasonText({ statusCode: 503, errorName: 'x', errorMessage: 'y' })).toBe(
      'Server error (503)',
    );
  });

  it('maps other status codes to a generic provider-error reason', () => {
    expect(retryReasonText({ statusCode: 418, errorName: 'x', errorMessage: 'y' })).toBe(
      'Provider error (418)',
    );
  });

  it('detects a connection timeout from the error name or message when no status code', () => {
    expect(
      retryReasonText({
        statusCode: undefined,
        errorName: 'FetchError',
        errorMessage: 'request timed out',
      }),
    ).toBe('Connection timed out');
    expect(
      retryReasonText({ statusCode: undefined, errorName: 'TimeoutError', errorMessage: 'nope' }),
    ).toBe('Connection timed out');
  });

  it('falls back to a generic connection issue with no status code and no timeout hint', () => {
    expect(
      retryReasonText({
        statusCode: undefined,
        errorName: 'ECONNRESET',
        errorMessage: 'socket hang up',
      }),
    ).toBe('Connection issue');
  });
});

describe('formatRetryLabel', () => {
  it('rounds the remaining backoff up to whole seconds', () => {
    const status = makeStatus({ statusCode: 429, nextRetryAt: 10_000 });
    expect(formatRetryLabel(status, 9_500)).toBe(
      'Rate limited (429) · attempt 2/10 · retrying in 1s',
    );
  });

  it('shows "retrying now" once the backoff window has elapsed', () => {
    const status = makeStatus({ statusCode: 429, nextRetryAt: 10_000 });
    expect(formatRetryLabel(status, 10_000)).toBe(
      'Rate limited (429) · attempt 2/10 · retrying now…',
    );
    expect(formatRetryLabel(status, 10_500)).toBe(
      'Rate limited (429) · attempt 2/10 · retrying now…',
    );
  });
});

describe('buildRetryStatus', () => {
  it('copies event fields and computes nextRetryAt from now + delayMs', () => {
    const event: TurnStepRetryingEvent = {
      type: 'turn.step.retrying',
      turnId: 1,
      step: 0,
      failedAttempt: 3,
      nextAttempt: 4,
      maxAttempts: 10,
      delayMs: 2_000,
      errorName: 'RateLimitError',
      errorMessage: 'slow down',
      statusCode: 429,
    };
    expect(buildRetryStatus(event, 5_000)).toEqual({
      failedAttempt: 3,
      nextAttempt: 4,
      maxAttempts: 10,
      delayMs: 2_000,
      nextRetryAt: 7_000,
      errorName: 'RateLimitError',
      errorMessage: 'slow down',
      statusCode: 429,
    });
  });
});
