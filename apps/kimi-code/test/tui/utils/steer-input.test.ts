import { describe, expect, it } from 'vitest';

import { foldMediaPathTagRefs } from '@moonshot-ai/kimi-code-sdk';

import { combineSteerInput } from '#/tui/utils/steer-input';

describe('combineSteerInput', () => {
  const tag = '<image path="/cache/f_1.png"></image>';
  const refPart = {
    type: 'image_url',
    imageUrl: { url: 'kimi-file://f_1?path=%2Fcache%2Ff_1.png' },
  } as const;

  it('keeps a standalone <media path> tag as its own part so the engine pairing survives', () => {
    const result = combineSteerInput([
      {
        text: 'what is this?',
        parts: [{ type: 'text', text: 'what is this? ' }, { type: 'text', text: tag }, refPart],
      },
    ]);
    expect(result).toEqual([
      { type: 'text', text: 'what is this? ' },
      { type: 'text', text: tag },
      refPart,
    ]);
    // The pair still folds: one claimed tag, one media ref.
    const folded = foldMediaPathTagRefs(result as never);
    expect(folded.media).toHaveLength(1);
    expect(folded.parts).toHaveLength(2);
  });

  it('merges plain text across items without absorbing adjacent media tags', () => {
    const result = combineSteerInput([
      {
        text: 'a',
        parts: [
          { type: 'text', text: 'a ' },
          { type: 'text', text: '<image path="/cache/f_1.png"></image>' },
          refPart,
        ],
      },
      {
        text: 'b',
        parts: [
          { type: 'text', text: 'b ' },
          { type: 'text', text: '<image path="/cache/f_1.png"></image>' },
          refPart,
        ],
      },
    ]);
    expect(result).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'text', text: '<image path="/cache/f_1.png"></image>' },
      refPart,
      { type: 'text', text: '\n\nb ' },
      { type: 'text', text: '<image path="/cache/f_1.png"></image>' },
      refPart,
    ]);
  });

  it('joins text-only items with the historical separator', () => {
    expect(combineSteerInput([{ text: 'one' }, { text: 'two' }])).toBe('one\n\ntwo');
  });
});
