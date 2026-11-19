import { describe, expect, it } from 'vitest';
import { replaceWithSourceMap, sourceOffsetAfter, sourceOffsetAt } from '../src/lib/sourceMappedText';

describe('replaceWithSourceMap', () => {
  it('is the identity when nothing is replaced', () => {
    const mapped = replaceWithSourceMap('/compact now');
    expect(mapped.text).toBe('/compact now');
    expect(sourceOffsetAt(mapped, 0)).toBe(0);
    expect(sourceOffsetAfter(mapped, 8)).toBe(8);
    expect(sourceOffsetAfter(mapped, mapped.text.length)).toBe(12);
  });

  it('maps offsets past a dropped span back to the original text', () => {
    const source = '<<pill>> /clear';
    const mapped = replaceWithSourceMap(source, [{ start: 0, end: 8 }]);
    expect(mapped.text).toBe(' /clear');
    expect(sourceOffsetAt(mapped, 1)).toBe(9);
    expect(sourceOffsetAfter(mapped, 7)).toBe(15);
    expect(source.slice(sourceOffsetAt(mapped, 1), sourceOffsetAfter(mapped, 7))).toBe('/clear');
  });

  it('ends a run at the last kept character, not at the end of a trailing drop', () => {
    const source = '<<a>>/new<<b>>';
    const mapped = replaceWithSourceMap(source, [{ start: 0, end: 5 }, { start: 9, end: 14 }]);
    expect(mapped.text).toBe('/new');
    expect(sourceOffsetAt(mapped, 0)).toBe(5);
    expect(sourceOffsetAfter(mapped, 4)).toBe(9);
    expect(source.slice(5, 9)).toBe('/new');
  });

  it('anchors inserted replacement text to the span it stands in for', () => {
    const mapped = replaceWithSourceMap('a<<q>>b', [{ start: 1, end: 6, text: 'note' }]);
    expect(mapped.text).toBe('anoteb');
    expect(sourceOffsetAt(mapped, 1)).toBe(1);
    expect(sourceOffsetAfter(mapped, 5)).toBe(6);
    expect(sourceOffsetAfter(mapped, mapped.text.length)).toBe(7);
  });

  it('unions overlapping spans and accepts them out of order', () => {
    const mapped = replaceWithSourceMap('abcdef', [{ start: 4, end: 6 }, { start: 1, end: 3 }, { start: 2, end: 5 }]);
    expect(mapped.text).toBe('a');
    expect(sourceOffsetAt(mapped, 0)).toBe(0);
    expect(sourceOffsetAfter(mapped, 1)).toBe(1);
  });
});
