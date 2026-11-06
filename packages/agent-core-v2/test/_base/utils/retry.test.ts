import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readRetryAfterMs,
  retryBackoffDelay,
  retryBackoffDelays,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { userCancellationReason } from '#/_base/utils/abort';

describe('sleepForRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after delayMs', async () => {
    let settled = false;
    const promise = sleepForRetry(1000).then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(settled).toBe(true);
  });

  it('resolves immediately when delayMs is zero or negative', async () => {
    await expect(sleepForRetry(0)).resolves.toBeUndefined();
    await expect(sleepForRetry(-50)).resolves.toBeUndefined();
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    controller.abort(reason);

    await expect(sleepForRetry(1000, controller.signal)).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the pending timer and rejects when signal aborts mid-sleep', async () => {
    const controller = new AbortController();
    const reason = userCancellationReason();
    const promise = sleepForRetry(10_000, controller.signal);

    expect(vi.getTimerCount()).toBe(1);

    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up the abort listener upon timer completion', async () => {
    const controller = new AbortController();
    const promise = sleepForRetry(100, controller.signal);

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('readRetryAfterMs', () => {
  it('reads positive numbers', () => {
    expect(readRetryAfterMs({ retryAfterMs: 5000 })).toBe(5000);
  });

  it('returns null for missing, non-number, or non-positive values', () => {
    expect(readRetryAfterMs(null)).toBeNull();
    expect(readRetryAfterMs({})).toBeNull();
    expect(readRetryAfterMs({ retryAfterMs: '5000' })).toBeNull();
    expect(readRetryAfterMs({ retryAfterMs: 0 })).toBeNull();
    expect(readRetryAfterMs({ retryAfterMs: -100 })).toBeNull();
  });
});

describe('retryBackoffDelay', () => {
  it('calculates bounded delays', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const delay = retryBackoffDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(40_000);
    }
  });

  it('produces the requested count of delays', () => {
    expect(retryBackoffDelays(0)).toEqual([]);
    expect(retryBackoffDelays(1)).toEqual([]);
    expect(retryBackoffDelays(4)).toHaveLength(3);
  });
});

describe('retryErrorFields', () => {
  it('extracts status code from error or details', () => {
    expect(retryErrorFields(new Error('err'))).toEqual({
      errorName: 'Error',
      errorMessage: 'err',
      statusCode: undefined,
    });
    expect(retryErrorFields({ name: 'Cust', message: 'msg', statusCode: 429 })).toEqual({
      errorName: 'object',
      errorMessage: '[object Object]',
      statusCode: 429,
    });
    expect(retryErrorFields({ details: { statusCode: 503 } })).toEqual({
      errorName: 'object',
      errorMessage: '[object Object]',
      statusCode: 503,
    });
  });
});
