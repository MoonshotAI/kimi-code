import { describe, expect, it } from 'vitest';

import { codePointBoundaryStart, sliceOnCodePointBoundary } from '#/_base/text/code-points';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('sliceOnCodePointBoundary', () => {
  it('returns the input when it fits within the limit', () => {
    expect(sliceOnCodePointBoundary('short', 10)).toBe('short');
    expect(sliceOnCodePointBoundary('exact', 5)).toBe('exact');
  });

  it('cuts plain text at the limit', () => {
    expect(sliceOnCodePointBoundary('abcdef', 3)).toBe('abc');
  });

  it('backs off when the cut lands inside a surrogate pair', () => {
    const text = `${'a'.repeat(3)}\u{1F600}\u{1F601}`;
    expect(sliceOnCodePointBoundary(text, 4)).toBe('aaa');
  });

  it('keeps a complete pair that ends exactly at the limit', () => {
    const text = `${'a'.repeat(3)}\u{1F600}zz`;
    expect(sliceOnCodePointBoundary(text, 5)).toBe('aaa\u{1F600}');
  });

  it('drops a lone trailing high surrogate at the cut', () => {
    const text = `ab\uD83Dcd`;
    expect(sliceOnCodePointBoundary(text, 3)).toBe('ab');
  });

  it('never emits a lone surrogate across randomized cuts', () => {
    const text = Array.from({ length: 200 }, (_, i) =>
      i % 3 === 0 ? '\u{1F600}' : 'x',
    ).join('');
    for (let end = 0; end <= text.length + 1; end++) {
      expect(LONE_SURROGATE.test(sliceOnCodePointBoundary(text, end))).toBe(false);
    }
  });
});

describe('codePointBoundaryStart', () => {
  it('returns the start unchanged on a code point boundary', () => {
    expect(codePointBoundaryStart('abcdef', 3)).toBe(3);
    expect(codePointBoundaryStart('abcdef', 0)).toBe(0);
    expect(codePointBoundaryStart('abcdef', 6)).toBe(6);
  });

  it('advances past a low surrogate whose high half precedes the start', () => {
    const text = `${'a'.repeat(3)}\u{1F600}zz`;
    expect(codePointBoundaryStart(text, 4)).toBe(5);
    expect(text.slice(5)).toBe('zz');
  });

  it('does not advance past a lone low surrogate', () => {
    const text = `ab\uDC00cd`;
    expect(codePointBoundaryStart(text, 2)).toBe(2);
  });
});
