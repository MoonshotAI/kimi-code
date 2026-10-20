import { describe, expect, it } from 'vitest';

import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';

import type { SteerInputItem } from '#/tui/types';
import { combineSteerInput } from '#/tui/utils/steer-input';

describe('combineSteerInput', () => {
  const refPart = {
    type: 'image_url',
    imageUrl: { url: 'kimi-file://f_1?path=%2Fcache%2Ff_1.png' },
  } as const;

  it('keeps a bare daemon-ref part intact while merging the surrounding text', () => {
    const result = combineSteerInput([
      {
        text: 'what is this?',
        parts: [{ type: 'text', text: 'what is this? ' }, refPart],
      },
    ]);
    expect(result).toEqual([{ type: 'text', text: 'what is this? ' }, refPart]);
  });

  it('merges plain text across items around the media parts', () => {
    const result = combineSteerInput([
      { text: 'a', parts: [{ type: 'text', text: 'a ' }, refPart] },
      { text: 'b', parts: [{ type: 'text', text: 'b ' }, refPart] },
    ]);
    expect(result).toEqual([
      { type: 'text', text: 'a ' },
      refPart,
      { type: 'text', text: '\n\nb ' },
      refPart,
    ]);
  });

  it.each([
    {
      name: 'between two touching media parts',
      first: { text: '', parts: [refPart] } as SteerInputItem,
      head: [] as PromptPart[],
    },
    {
      name: 'when a media-ending item is followed by a media-first item',
      first: {
        text: 'a',
        parts: [{ type: 'text', text: 'a ' }, refPart],
      } as SteerInputItem,
      head: [{ type: 'text', text: 'a ' }] as PromptPart[],
    },
  ])('drops the separator $name', ({ first, head }) => {
    // Inserting '\n\n' there would strand a whitespace-only text part between
    // the two media parts, which `normalizePromptInput` rejects.
    const refPart2 = {
      type: 'image_url',
      imageUrl: { url: 'kimi-file://f_2?path=%2Fcache%2Ff_2.png' },
    } as const;
    const result = combineSteerInput([first, { text: '', parts: [refPart2] }]);
    expect(result).toEqual([...head, refPart, refPart2]);
  });

  it('treats a standalone <media path> tag as plain user text', () => {
    // Extraction no longer authors machine tags, so a tag in the input is
    // user text: it merges with adjacent text instead of staying atomic.
    const tag = '<image path="/cache/f_1.png"></image>';
    const result = combineSteerInput([
      {
        text: `look ${tag}`,
        parts: [{ type: 'text', text: 'look ' }, { type: 'text', text: tag }, refPart],
      },
    ]);
    expect(result).toEqual([{ type: 'text', text: `look ${tag}` }, refPart]);
  });

  it('joins text-only items with the historical separator', () => {
    expect(combineSteerInput([{ text: 'one' }, { text: 'two' }])).toBe('one\n\ntwo');
  });
});
