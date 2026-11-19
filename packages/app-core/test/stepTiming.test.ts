import { describe, expect, it } from 'vitest';

import { formatStepMs, requestCacheHitRate, requestInputTotal, requestTps } from '../src/lib/stepTiming';

const usage = (input_other: number, input_cache_read: number, input_cache_creation: number, output = 200) => ({
  input_other,
  input_cache_read,
  input_cache_creation,
  output,
});

describe('request debug figures', () => {
  it('sums every input component and computes the cache read share of it', () => {
    expect(requestInputTotal(usage(700, 1200, 100))).toBe(2000);
    expect(requestCacheHitRate(usage(700, 1200, 100))).toBe(60);
    expect(requestCacheHitRate(usage(1000, 0, 0))).toBe(0);
    expect(requestCacheHitRate(usage(0, 0, 0))).toBeUndefined();
  });

  it('computes tokens per second only from a measurable stream with output', () => {
    expect(requestTps({ usage: usage(0, 0, 0, 20), timing: { stream_ms: 50 } })).toBe(400);
    expect(requestTps({ usage: usage(0, 0, 0, 200), timing: { stream_ms: 5000 } })).toBe(40);
    expect(requestTps({ usage: usage(0, 0, 0, 100), timing: { stream_ms: 49 } })).toBeUndefined();
    expect(requestTps({ usage: usage(0, 0, 0, 0), timing: { stream_ms: 500 } })).toBeUndefined();
    expect(requestTps({ timing: { stream_ms: 500 } })).toBeUndefined();
  });
});

describe('formatStepMs', () => {
  it('formats sub-second durations as milliseconds and longer ones as seconds', () => {
    expect(formatStepMs(0)).toBe('0ms');
    expect(formatStepMs(999)).toBe('999ms');
    expect(formatStepMs(1000)).toBe('1.0s');
    expect(formatStepMs(3700)).toBe('3.7s');
  });
});
