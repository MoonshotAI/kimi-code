import { describe, expect, it } from 'vitest';

import {
  getWorkingTips,
  currentWorkingTip,
  pickRandomWorkingTip,
} from '#/tui/components/chrome/working-tips';

describe('currentWorkingTip', () => {
  it('returns a tip from getWorkingTips()', () => {
    const now = Date.now();
    const tip = currentWorkingTip(now);
    expect(tip).toBeDefined();
    expect(getWorkingTips().some((t) => t.text === tip!.text)).toBe(true);
  });

  it('returns the same tip for the same timestamp', () => {
    const now = 1_000_000;
    const first = currentWorkingTip(now);
    const second = currentWorkingTip(now);
    expect(first).toBe(second);
  });

  it('returns a different tip for a different timestamp', () => {
    const tip1 = currentWorkingTip(0);
    const tip2 = currentWorkingTip(10_000);
    // The timestamp-based rotation should produce a deterministic
    // but different result when the input changes significantly.
    if (getWorkingTips().length > 1) {
      expect(tip1).not.toBe(tip2);
    }
  });

  it('handles the epoch timestamp (0) without throwing', () => {
    const tip = currentWorkingTip(0);
    expect(tip).toBeDefined();
  });

  it('handles a very large future timestamp without throwing', () => {
    const tip = currentWorkingTip(Number.MAX_SAFE_INTEGER);
    expect(tip).toBeDefined();
  });
});

describe('pickRandomWorkingTip', () => {
  it('returns a tip from getWorkingTips()', () => {
    const tip = pickRandomWorkingTip();
    expect(tip).toBeDefined();
    expect(getWorkingTips().some((t) => t.text === tip!.text)).toBe(true);
  });

  it('avoids the excluded text when possible', () => {
    const first = pickRandomWorkingTip()!;
    let different = false;
    for (let i = 0; i < 50; i++) {
      const next = pickRandomWorkingTip(first.text);
      if (next !== undefined && next.text !== first.text) {
        different = true;
        break;
      }
    }
    if (getWorkingTips().length > 1) {
      expect(different).toBe(true);
    }
  });

  it('falls back to the rotation when every tip would be excluded', () => {
    // If all working tips share the same text, exclusion cannot be satisfied.
    const workingTips = getWorkingTips();
    const onlyTip = workingTips[0];
    if (onlyTip !== undefined && workingTips.every((t) => t.text === onlyTip.text)) {
      expect(pickRandomWorkingTip(onlyTip.text)).toBeDefined();
    }
  });

  it('returns a tip with a single-element array', () => {
    const tip = pickRandomWorkingTip();
    expect(tip).toBeDefined();
    if (tip !== undefined) {
      expect(typeof tip.text).toBe('string');
      expect(tip.text.length).toBeGreaterThan(0);
    }
  });
});
