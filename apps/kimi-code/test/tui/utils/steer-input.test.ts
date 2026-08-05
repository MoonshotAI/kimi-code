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

  it('drops the separator between a trailing media part and a leading standalone tag', () => {
    // Two queued pure-image messages: each item's parts open with the tag.
    // Inserting '\n\n' there would strand a whitespace-only text part between
    // the media part and the atomic tag, which `normalizePromptInput` rejects.
    const tag2 = '<image path="/cache/f_2.png"></image>';
    const refPart2 = {
      type: 'image_url',
      imageUrl: { url: 'kimi-file://f_2?path=%2Fcache%2Ff_2.png' },
    } as const;
    const result = combineSteerInput([
      { text: '', parts: [{ type: 'text', text: tag }, refPart] },
      { text: '', parts: [{ type: 'text', text: tag2 }, refPart2] },
    ]);
    expect(result).toEqual([{ type: 'text', text: tag }, refPart, { type: 'text', text: tag2 }, refPart2]);
    // Both pairs still fold: two claimed tags, two media refs, no cross-claim.
    const folded = foldMediaPathTagRefs(result as never);
    expect(folded.media).toHaveLength(2);
    expect(folded.parts).toHaveLength(2);
  });

  it('drops the separator when a media-ending item is followed by a tag-first item', () => {
    const result = combineSteerInput([
      { text: 'a', parts: [{ type: 'text', text: 'a ' }, { type: 'text', text: tag }, refPart] },
      { text: '', parts: [{ type: 'text', text: tag }, refPart] },
    ]);
    expect(result).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'text', text: tag },
      refPart,
      { type: 'text', text: tag },
      refPart,
    ]);
  });

  it('joins text-only items with the historical separator', () => {
    expect(combineSteerInput([{ text: 'one' }, { text: 'two' }])).toBe('one\n\ntwo');
  });
});
