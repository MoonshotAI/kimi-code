import { describe, expect, it } from 'vitest';
import { mentionMatchSpans } from '@/lib/mention-match';

describe('mentionMatchSpans', () => {
  it('returns the whole text as a plain span when positions are missing or empty', () => {
    expect(mentionMatchSpans('app.ts', undefined, 0)).toEqual([{ text: 'app.ts', hit: false }]);
    expect(mentionMatchSpans('app.ts', [], 0)).toEqual([{ text: 'app.ts', hit: false }]);
    expect(mentionMatchSpans('', [0], 0)).toEqual([{ text: '', hit: false }]);
  });

  it('splits hit and plain runs by position', () => {
    expect(mentionMatchSpans('app.ts', [0, 1, 4], 0)).toEqual([
      { text: 'ap', hit: true },
      { text: 'p.', hit: false },
      { text: 't', hit: true },
      { text: 's', hit: false },
    ]);
  });

  it('shifts path-frame positions into the name frame via start', () => {
    // path 'src/app.ts' (len 10), name 'app.ts' → start = 6
    expect(mentionMatchSpans('app.ts', [6, 7, 10], 6)).toEqual([
      { text: 'ap', hit: true },
      { text: 'p.', hit: false },
      { text: 't', hit: true },
      { text: 's', hit: false },
    ]);
  });

  it('drops positions outside the text frame', () => {
    expect(mentionMatchSpans('app.ts', [0, 1, 2], 6)).toEqual([{ text: 'app.ts', hit: false }]);
    expect(mentionMatchSpans('src', [0, 6, 7], 0)).toEqual([
      { text: 's', hit: true },
      { text: 'rc', hit: false },
    ]);
  });

  it('handles adjacent hits as a single run', () => {
    expect(mentionMatchSpans('abc', [0, 1, 2], 0)).toEqual([{ text: 'abc', hit: true }]);
  });
});
