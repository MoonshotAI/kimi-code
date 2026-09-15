import { describe, expect, it } from 'vitest';

import type { CacheHintConfig } from '#/utils/cache-hint-config';
import { evaluateCacheHint, formatIdleDuration } from '#/tui/utils/cache-hint';

const CONFIG: CacheHintConfig = {
  version: 1,
  config: {
    k3: { min_tokens_to_hint: 100000, cache_duration: 600 },
  },
};

const NOW = 1_800_000_000_000;
const IDLE_BEYOND_TTL = NOW - 601_000; // 601s > 600s cache_duration

function input(overrides: Partial<Parameters<typeof evaluateCacheHint>[0]> = {}) {
  return {
    now: NOW,
    lastActiveAt: IDLE_BEYOND_TTL,
    totalTokens: 150000,
    modelId: 'k3',
    config: CONFIG,
    dismissed: false,
    ...overrides,
  };
}

describe('evaluateCacheHint', () => {
  it('hints when idle exceeds cache_duration and tokens clear the threshold', () => {
    expect(evaluateCacheHint(input())).toEqual({
      kind: 'hint',
      idleSeconds: 601,
      totalTokens: 150000,
    });
  });

  it('skips when dismissed', () => {
    expect(evaluateCacheHint(input({ dismissed: true })).kind).toBe('skip');
  });

  it.each([
    ['config', { config: undefined }],
    ['modelId', { modelId: undefined }],
    ['lastActiveAt', { lastActiveAt: undefined }],
    ['totalTokens', { totalTokens: undefined }],
  ] as const)('skips when %s is missing', (_name, overrides) => {
    expect(evaluateCacheHint(input(overrides)).kind).toBe('skip');
  });

  it('skips when the model is not in the config', () => {
    expect(evaluateCacheHint(input({ modelId: 'unknown-model' })).kind).toBe('skip');
  });

  it('skips at exactly cache_duration (strictly-greater rule)', () => {
    expect(
      evaluateCacheHint(input({ lastActiveAt: NOW - 600_000 })).kind,
    ).toBe('skip');
  });

  it('skips below the token threshold', () => {
    expect(evaluateCacheHint(input({ totalTokens: 99999 })).kind).toBe('skip');
  });

  it('skips on clock skew (negative idle)', () => {
    expect(evaluateCacheHint(input({ lastActiveAt: NOW + 60_000 })).kind).toBe('skip');
  });
});

describe('formatIdleDuration', () => {
  it.each([
    [45 * 60, '45m'],
    [60 * 60, '1h'],
    [(3 * 60 + 20) * 60, '3h 20m'],
    [24 * 60 * 60, '1d'],
    [(2 * 24 + 4) * 60 * 60, '2d 4h'],
    [(26 * 24 + 22) * 60 * 60, '26d 22h'],
  ])('formats %ss as %s', (seconds, expected) => {
    expect(formatIdleDuration(seconds)).toBe(expected);
  });
});
