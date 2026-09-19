import { describe, expect, it } from 'vitest';

import { applyPatterns, type Pattern, type Rewrite } from '#/llm/protocol/rewrite';

function pairToSum(name: string): Pattern<number> {
  return {
    name,
    rewrite(items, index): Rewrite<number> | null {
      const a = items[index];
      const b = items[index + 1];
      if (a === undefined || b === undefined) return null;
      return { consumed: 2, replacement: [a + b] };
    },
  };
}

function dropOdd(): Pattern<number> {
  return {
    name: 'dropOdd',
    rewrite(items, index): Rewrite<number> | null {
      const value = items[index];
      if (value === undefined || value % 2 === 0) return null;
      return { consumed: 1, replacement: [] };
    },
  };
}

function splitEven(): Pattern<number> {
  return {
    name: 'splitEven',
    rewrite(items, index): Rewrite<number> | null {
      const value = items[index];
      if (value === undefined || value % 2 !== 0) return null;
      return { consumed: 1, replacement: [value / 2, value / 2] };
    },
  };
}

describe('applyPatterns', () => {
  it('returns a copy unchanged when no pattern matches', () => {
    const input = [2, 4, 6];
    const out = applyPatterns(input, [dropOdd()]);
    expect(out).toEqual([2, 4, 6]);
    expect(out).not.toBe(input);
  });

  it('applies patterns in order, one pass each', () => {
    const out = applyPatterns([2, 4, 1, 1], [pairToSum('sum'), splitEven()]);
    expect(out).toEqual([3, 3, 1, 1]);
  });

  it('later patterns see the output of earlier patterns', () => {
    const out = applyPatterns([2, 2], [pairToSum('sum'), splitEven()]);
    expect(out).toEqual([2, 2]);
  });

  it('supports run matching with multi-item consumption', () => {
    const out = applyPatterns([1, 2, 3, 4, 5], [pairToSum('sum')]);
    expect(out).toEqual([3, 7, 5]);
  });

  it('supports dropping items with an empty replacement', () => {
    const out = applyPatterns([1, 2, 3, 4], [dropOdd()]);
    expect(out).toEqual([2, 4]);
  });

  it('supports one-to-many replacement', () => {
    const out = applyPatterns([1, 4, 3], [splitEven()]);
    expect(out).toEqual([1, 2, 2, 3]);
  });
});
