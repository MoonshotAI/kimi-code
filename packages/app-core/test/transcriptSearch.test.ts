import { describe, expect, it } from 'vitest';
import { collapseWhitespaceWithMap, findMatchesInSegments, findOccurrences, foldCaseWithMap, isFindKeyEvent, whitespaceModeOf } from '../src/lib/transcriptSearch';

// Minimal KeyboardEvent stand-in for the node test environment.
function keyEvent(init: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
}) {
  return {
    key: init.key,
    code: init.code,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
  };
}

describe('isFindKeyEvent', () => {
  it('matches Cmd+F on Apple platforms and Ctrl+F elsewhere', () => {
    expect(isFindKeyEvent(keyEvent({ key: 'f', metaKey: true }), true)).toBe(true);
    expect(isFindKeyEvent(keyEvent({ key: 'f', ctrlKey: true }), false)).toBe(true);
  });

  it('ignores the non-platform modifier', () => {
    expect(isFindKeyEvent(keyEvent({ key: 'f', ctrlKey: true }), true)).toBe(false);
    expect(isFindKeyEvent(keyEvent({ key: 'f', metaKey: true }), false)).toBe(false);
  });

  it('rejects chords that add extra modifiers', () => {
    expect(isFindKeyEvent(keyEvent({ key: 'f', metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isFindKeyEvent(keyEvent({ key: 'f', metaKey: true, altKey: true }), true)).toBe(false);
    expect(isFindKeyEvent(keyEvent({ key: 'F', metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isFindKeyEvent(keyEvent({ key: 'f' }), true)).toBe(false);
    expect(isFindKeyEvent(keyEvent({ key: 'g', metaKey: true }), true)).toBe(false);
  });

  it('matches caps-lock F', () => {
    expect(isFindKeyEvent(keyEvent({ key: 'F', metaKey: true }), true)).toBe(true);
    expect(isFindKeyEvent(keyEvent({ key: 'F', ctrlKey: true }), false)).toBe(true);
  });

  it('matches the physical KeyF on non-Latin layouts', () => {
    // Cyrillic layout: physical F produces 'а', but the browser still fires
    // find-in-page on that key position.
    expect(isFindKeyEvent(keyEvent({ key: 'а', code: 'KeyF', metaKey: true }), true)).toBe(true);
    expect(isFindKeyEvent(keyEvent({ key: 'а', code: 'KeyF', ctrlKey: true }), false)).toBe(true);
    // A non-F key position with a non-'f' char is not find.
    expect(isFindKeyEvent(keyEvent({ key: 'з', code: 'KeyQ', metaKey: true }), true)).toBe(false);
  });

  it('leaves keys an earlier component consumed alone', () => {
    expect(
      isFindKeyEvent(keyEvent({ key: 'f', metaKey: true, defaultPrevented: true }), true),
    ).toBe(false);
  });
});

describe('findOccurrences', () => {
  it('finds every occurrence in order, as original-text offsets', () => {
    expect(findOccurrences('foo bar foo baz foo', 'foo')).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
      { start: 16, end: 19 },
    ]);
  });

  it('matches case-insensitively', () => {
    const expected = [
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ];
    expect(findOccurrences('Hello hELLO hello', 'hello')).toEqual(expected);
    expect(findOccurrences('Hello hELLO hello', 'HELLO')).toEqual(expected);
  });

  it('matches CJK text', () => {
    expect(findOccurrences('测试一下再测试', '测试')).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ]);
  });

  it('does not count overlapping occurrences (browser find rule)', () => {
    // 'aa' in 'aaaa': matches at 0 and 2, not 0/1/2.
    expect(findOccurrences('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(findOccurrences('aaa', 'aa')).toEqual([{ start: 0, end: 2 }]);
  });

  it('returns [] for an empty query or no match', () => {
    expect(findOccurrences('anything', '')).toEqual([]);
    expect(findOccurrences('', 'x')).toEqual([]);
    expect(findOccurrences('abc', 'z')).toEqual([]);
  });

  it('maps offsets back to the original text when folding changes length', () => {
    // İ lowercases to i̇ — two UTF-16 units from one. Offsets computed on the
    // folded string used to escape the 2-unit original and crash setEnd.
    expect(findOccurrences('İİ', 'İ')).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
    // Query side folds too: 'i' still finds the (folded) dotted-i sequence.
    expect(findOccurrences('İ', 'i')).toEqual([{ start: 0, end: 1 }]);
  });
});

describe('findMatchesInSegments', () => {
  it('matches across segments of one block (bold/code/highlight spans)', () => {
    // <p>foo <strong>bar</strong></p> renders as adjacent text nodes; the
    // visible phrase "foo bar" must match, spanning both.
    expect(
      findMatchesInSegments(
        [
          { text: 'foo ', gapBefore: true },
          { text: 'bar', gapBefore: false },
        ],
        'foo bar',
      ),
    ).toEqual([{ startSeg: 0, startOffset: 0, endSeg: 1, endOffset: 3 }]);
  });

  it('never matches across a block boundary, but matches on each side', () => {
    const segments = [
      { text: 'foo', gapBefore: true },
      { text: 'bar', gapBefore: true },
    ];
    expect(findMatchesInSegments(segments, 'foobar')).toEqual([]);
    expect(findMatchesInSegments(segments, 'foo')).toEqual([
      { startSeg: 0, startOffset: 0, endSeg: 0, endOffset: 3 },
    ]);
  });

  it('keeps case-folded offsets valid across segments', () => {
    // İ folds to two units; a cross-segment match must still map back to
    // original offsets on both sides.
    expect(
      findMatchesInSegments(
        [
          { text: 'xİ', gapBefore: true },
          { text: 'İy', gapBefore: false },
        ],
        'İİ',
      ),
    ).toEqual([{ startSeg: 0, startOffset: 1, endSeg: 1, endOffset: 1 }]);
  });

  it('matches query whitespace runs against any text whitespace run', () => {
    // Collapsed body (soft break → one space): both spellings match.
    const collapsed = [{ text: 'foo bar', gapBefore: true }];
    expect(findMatchesInSegments(collapsed, 'foo  bar')).toEqual([
      { startSeg: 0, startOffset: 0, endSeg: 0, endOffset: 7 },
    ]);
    // Preserved body (two spaces, e.g. <pre>): a two-space query must match
    // the two-space text — and must NOT miss it the way a collapsed
    // single-space needle would.
    const preserved = [{ text: 'foo  bar', gapBefore: true }];
    expect(findMatchesInSegments(preserved, 'foo  bar')).toEqual([
      { startSeg: 0, startOffset: 0, endSeg: 0, endOffset: 8 },
    ]);
    expect(findMatchesInSegments(preserved, 'foo bar')).toEqual([
      { startSeg: 0, startOffset: 0, endSeg: 0, endOffset: 8 },
    ]);
  });

  it('never crosses the block separator on a whitespace run', () => {
    const segments = [
      { text: 'foo', gapBefore: true },
      { text: 'bar', gapBefore: true },
    ];
    expect(findMatchesInSegments(segments, 'foo bar')).toEqual([]);
  });

  it('escapes regex specials in the query', () => {
    expect(
      findMatchesInSegments([{ text: 'a.b a*b', gapBefore: true }], 'a.b'),
    ).toEqual([{ startSeg: 0, startOffset: 0, endSeg: 0, endOffset: 3 }]);
  });

  it('returns [] for an empty query or no segments', () => {
    expect(findMatchesInSegments([{ text: 'abc', gapBefore: true }], '')).toEqual([]);
    expect(findMatchesInSegments([], 'abc')).toEqual([]);
  });
  it('dedupes folded-expansion hits that map to the same original span', () => {
    // ß folds to 'ss': searching 's' hits twice in the folded string but
    // both hits are the same original character — one match, one Range.
    expect(findOccurrences('ß', 's')).toEqual([{ start: 0, end: 1 }]);
    // …while genuinely separate originals still match individually.
    expect(findOccurrences('ßs', 's')).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  });
});

describe('collapseWhitespaceWithMap', () => {
  it('collapses runs (incl. soft line breaks) in normal mode', () => {
    expect(collapseWhitespaceWithMap('foo\n  bar', 'collapse')).toEqual({
      text: 'foo bar',
      map: [0, 1, 2, 3, 6, 7, 8],
    });
  });

  it('collapses spaces/tabs but keeps newlines in pre-line mode', () => {
    expect(collapseWhitespaceWithMap('a \t b\nc', 'pre-line')).toEqual({
      text: 'a b\nc',
      map: [0, 1, 4, 5, 6],
    });
  });

  it('keeps everything verbatim in preserve mode', () => {
    expect(collapseWhitespaceWithMap('a\n  b', 'preserve')).toEqual({
      text: 'a\n  b',
      map: [0, 1, 2, 3, 4],
    });
  });

  it('maps white-space modes from computed values', () => {
    expect(whitespaceModeOf('normal')).toBe('collapse');
    expect(whitespaceModeOf('nowrap')).toBe('collapse');
    expect(whitespaceModeOf('pre-line')).toBe('pre-line');
    expect(whitespaceModeOf('pre')).toBe('preserve');
    expect(whitespaceModeOf('pre-wrap')).toBe('preserve');
    expect(whitespaceModeOf('break-spaces')).toBe('preserve');
  });
  it('folds uppercase supplement forms the same as lowercase (ẞ/ß)', () => {
    // ẞ lowercases to ß, which then folds to ss — the same as body ß.
    expect(findOccurrences('ẞ', 'ß')).toEqual([{ start: 0, end: 1 }]);
    expect(findOccurrences('ß', 'ẞ')).toEqual([{ start: 0, end: 1 }]);
    expect(findOccurrences('groẞe', 'grosse')).toEqual([{ start: 0, end: 5 }]);
  });
});

describe('foldCaseWithMap', () => {
  it('records which original code point produced each folded unit', () => {
    expect(foldCaseWithMap('aİb')).toEqual({
      folded: 'ai̇b',
      map: [
        { start: 0, length: 1 },
        { start: 1, length: 1 },
        { start: 1, length: 1 },
        { start: 2, length: 1 },
      ],
    });
    expect(foldCaseWithMap('')).toEqual({ folded: '', map: [] });
  });

  it('folds per code point so both sides agree (Greek, supplementary plane)', () => {
    // Σ and ς both fold to σ — whole-string toLowerCase() would produce the
    // context-sensitive final sigma ς and miss the body's 'ΟΣ'.
    expect(findOccurrences('ΟΣ χ', 'ος')).toEqual([{ start: 0, end: 2 }]);
    expect(findOccurrences('ος χ', 'ΟΣ')).toEqual([{ start: 0, end: 2 }]);
    // Deseret case pairs live outside the BMP (2 UTF-16 units per letter).
    expect(findOccurrences('𐐀𐐨', '𐐨')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});

// collectMatchRanges / setSearchHighlights are DOM paths (TreeWalker, Range,
// CSS Custom Highlight API), exercised manually in the app — the node test
// environment has no DOM, mirroring transcriptSelectAll.
