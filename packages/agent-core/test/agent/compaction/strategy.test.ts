import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COMPACTION_CONFIG,
  DefaultCompactionStrategy,
} from '../../../src/agent/compaction';

describe('DefaultCompactionStrategy', () => {
  it('triggers auto-compaction at 85% of the context window', () => {
    const strategy = new DefaultCompactionStrategy(() => 100_000, {
      ...DEFAULT_COMPACTION_CONFIG,
      reservedContextSize: 0,
    });

    expect(strategy.shouldCompact(84_999)).toBe(false);
    expect(strategy.shouldCompact(85_000)).toBe(true);
    expect(strategy.shouldCompact(100_000)).toBe(true);
  });

  it('blocks at the same threshold by default (synchronous compaction)', () => {
    const strategy = new DefaultCompactionStrategy(() => 100_000, {
      ...DEFAULT_COMPACTION_CONFIG,
      reservedContextSize: 0,
    });

    expect(strategy.shouldBlock(84_999)).toBe(false);
    expect(strategy.shouldBlock(85_000)).toBe(true);
    expect(strategy.checkAfterStep).toBe(false);
  });

  it('reserves response context before the ratio threshold is reached', () => {
    const strategy = new DefaultCompactionStrategy(() => 256_000);

    // 256k * 0.85 = 217_600, and the 50k reserve triggers at 206k.
    expect(strategy.shouldCompact(210_000)).toBe(true);
    expect(strategy.shouldBlock(210_000)).toBe(true);
  });

  it('ignores reserved context when the reserve is not smaller than the model window', () => {
    const strategy = new DefaultCompactionStrategy(() => 32_000, {
      triggerRatio: 0.9,
      blockRatio: 0.9,
      reservedContextSize: 50_000,
      maxCompactionPerTurn: 3,
      maxOverflowCompactionAttempts: 3,
    });

    expect(strategy.shouldCompact(1)).toBe(false);
    expect(strategy.shouldBlock(1)).toBe(false);
    // Falls back to the 90% ratio: 32_000 * 0.9 = 28_800.
    expect(strategy.shouldCompact(28_800)).toBe(true);
    expect(strategy.shouldBlock(28_800)).toBe(true);
  });

  it('does not compact when the context window is unknown', () => {
    const strategy = new DefaultCompactionStrategy(() => 0);

    expect(strategy.shouldCompact(1_000_000)).toBe(false);
    expect(strategy.shouldBlock(1_000_000)).toBe(false);
  });

  it('enables after-step checks only when ratios differ (async compaction)', () => {
    const strategy = new DefaultCompactionStrategy(() => 100_000, {
      triggerRatio: 0.8,
      blockRatio: 0.9,
      reservedContextSize: 0,
      maxCompactionPerTurn: 3,
      maxOverflowCompactionAttempts: 3,
    });

    expect(strategy.checkAfterStep).toBe(true);
  });

  it('exposes maxCompactionPerTurn', () => {
    const strategy = testCompactionStrategy();

    expect(strategy.maxCompactionPerTurn).toBe(3);
  });
});

function testCompactionStrategy(maxSize: number = 1_000): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => maxSize, {
    triggerRatio: 0.85,
    blockRatio: 0.85,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
    maxOverflowCompactionAttempts: 3,
  });
}
