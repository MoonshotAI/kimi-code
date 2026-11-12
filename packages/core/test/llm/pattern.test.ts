import { describe, expect, it } from 'vitest';

import { applyPatterns, type Pattern, type Rewrite } from '#/llm/protocol/pattern';

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
  it('applies ordered run rewrites without mutating the input', () => {
    const input = [2, 4, 6];
    const unchanged = applyPatterns(input, [dropOdd()]);
    expect(unchanged).toEqual(input);
    expect(unchanged).not.toBe(input);
    expect(applyPatterns([2, 4, 1, 1], [pairToSum('sum'), splitEven()])).toEqual([3, 3, 1, 1]);
    expect(applyPatterns([2, 2], [pairToSum('sum'), splitEven()])).toEqual([2, 2]);
    expect(applyPatterns([1, 2, 3, 4, 5], [pairToSum('sum')])).toEqual([3, 7, 5]);
    expect(applyPatterns([1, 2, 3, 4], [dropOdd()])).toEqual([2, 4]);
    expect(applyPatterns([1, 4, 3], [splitEven()])).toEqual([1, 2, 2, 3]);
  });
});
