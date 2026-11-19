import { describe, expect, it } from 'vitest';
import { mentionMatchSpans } from '../../../src/features/mention/match';

describe('mentionMatchSpans', () => {
  it('returns a single plain span when there is nothing to highlight', () => {
    expect(mentionMatchSpans('README.md', undefined, 0)).toEqual([{ text: 'README.md', hit: false }]);
    expect(mentionMatchSpans('README.md', [], 0)).toEqual([{ text: 'README.md', hit: false }]);
    expect(mentionMatchSpans('', [0], 0)).toEqual([{ text: '', hit: false }]);
    expect(mentionMatchSpans('src', [10, 11], 0)).toEqual([{ text: 'src', hit: false }]);
  });

  it('splits a label into alternating plain/hit runs', () => {
    expect(mentionMatchSpans('app.ts', [0, 4], 0)).toEqual([
      { text: 'a', hit: true },
      { text: 'pp.', hit: false },
      { text: 't', hit: true },
      { text: 's', hit: false },
    ]);
  });

  it('translates full-path positions into the name label (start offset)', () => {
    const positions = [13, 17];
    expect(mentionMatchSpans('app.ts', positions, 13)).toEqual([
      { text: 'a', hit: true },
      { text: 'pp.', hit: false },
      { text: 't', hit: true },
      { text: 's', hit: false },
    ]);
  });

  it('splits the directory label with positions inside the path prefix', () => {
    const positions = [0, 4, 5, 6, 7];
    expect(mentionMatchSpans('src/composer', positions, 0)).toEqual([
      { text: 's', hit: true },
      { text: 'rc/', hit: false },
      { text: 'comp', hit: true },
      { text: 'oser', hit: false },
    ]);
  });

  it('merges adjacent hit characters into one run', () => {
    expect(mentionMatchSpans('abc', [0, 1, 2], 0)).toEqual([{ text: 'abc', hit: true }]);
  });
});
