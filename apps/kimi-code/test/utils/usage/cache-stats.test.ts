import { describe, expect, it } from 'vitest';

import {
  CACHE_BREAK_MIN_PREFIX_TOKENS,
  cacheHitPercent,
  isLikelyCacheBreak,
  stepCacheStats,
} from '#/utils/usage/cache-stats';

describe('stepCacheStats', () => {
  it('returns cache read and input total from a usage breakdown', () => {
    expect(
      stepCacheStats({ inputOther: 100, inputCacheRead: 800, inputCacheCreation: 100, output: 50 }),
    ).toEqual({ cacheRead: 800, inputTotal: 1000 });
  });

  it('returns undefined without usage or without input tokens', () => {
    expect(stepCacheStats(undefined)).toBeUndefined();
    expect(
      stepCacheStats({ inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 10 }),
    ).toBeUndefined();
  });
});

describe('cacheHitPercent', () => {
  it('rounds to a whole percent', () => {
    expect(cacheHitPercent(800, 1000)).toBe(80);
    expect(cacheHitPercent(1, 3)).toBe(33);
    expect(cacheHitPercent(0, 1000)).toBe(0);
  });

  it('clamps cache read into [0, total]', () => {
    expect(cacheHitPercent(2000, 1000)).toBe(100);
    expect(cacheHitPercent(-5, 1000)).toBe(0);
  });

  it('returns undefined for unusable totals', () => {
    expect(cacheHitPercent(10, 0)).toBeUndefined();
    expect(cacheHitPercent(10, Number.NaN)).toBeUndefined();
  });
});

describe('isLikelyCacheBreak', () => {
  const bigPrefix = CACHE_BREAK_MIN_PREFIX_TOKENS * 2;

  it('flags a large shortfall against the previous warm prefix', () => {
    expect(
      isLikelyCacheBreak(bigPrefix, { cacheRead: 0, inputTotal: bigPrefix + 500 }),
    ).toBe(true);
    expect(
      isLikelyCacheBreak(bigPrefix, { cacheRead: bigPrefix * 0.4, inputTotal: bigPrefix + 500 }),
    ).toBe(true);
  });

  it('accepts a healthy sliding-prefix hit', () => {
    expect(
      isLikelyCacheBreak(bigPrefix, { cacheRead: bigPrefix * 0.9, inputTotal: bigPrefix + 500 }),
    ).toBe(false);
  });

  it('ignores small prefixes and missing history', () => {
    expect(
      isLikelyCacheBreak(CACHE_BREAK_MIN_PREFIX_TOKENS - 1, { cacheRead: 0, inputTotal: 12_000 }),
    ).toBe(false);
    expect(isLikelyCacheBreak(undefined, { cacheRead: 0, inputTotal: 12_000 })).toBe(false);
  });
});
