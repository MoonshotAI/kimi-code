import { describe, expect, it } from 'vitest';

import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';

import type { SteerInputItem } from '#/tui/types';
import { steerEventParts, steerMatchTexts, takeDeliveredSteerBatches } from '#/tui/utils/steer-delivery';
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

describe('takeDeliveredSteerBatches', () => {
  it('clears only the batch whose text the event carries', () => {
    const first = { text: 'keep this input', entries: ['keep this input'] };
    const second = { text: 'later', entries: ['later'] };
    const result = takeDeliveredSteerBatches([first, second], 'keep this input');
    expect(result.delivered).toEqual([first]);
    expect(result.pending).toEqual([second]);
  });

  it('does not treat a shorter steer as part of a different message', () => {
    const short = { text: 'hi', entries: ['hi'] };
    const result = takeDeliveredSteerBatches([short], 'this');
    expect(result.delivered).toEqual([]);
    expect(result.pending).toEqual([short]);
  });

  it('clears each joined segment of one merged event', () => {
    const first = { text: 'one', entries: ['one'] };
    const second = { text: 'two', entries: ['two'] };
    const result = takeDeliveredSteerBatches([first, second], 'one\n\ntwo');
    expect(result.delivered).toEqual([first, second]);
    expect(result.pending).toEqual([]);
  });

  it('matches split text parts as one payload and as separate submissions', () => {
    expect(steerMatchTexts(['hello ', 'world'])).toEqual(['hello world', 'hello ', 'world']);
    const combined = { text: 'hello world', entries: ['hello world'] };
    const first = { text: 'hello ', entries: ['hello '] };
    const second = { text: 'world', entries: ['world'] };
    expect(takeDeliveredSteerBatches([combined], 'hello world').delivered).toEqual([combined]);
    let pending: Array<{ readonly text: string; readonly entries: readonly string[] }> = [first, second];
    const delivered = [];
    for (const text of ['hello ', 'world']) {
      const step = takeDeliveredSteerBatches(pending, text);
      delivered.push(...step.delivered);
      pending = step.pending;
    }
    expect(delivered).toEqual([first, second]);
    expect(pending).toEqual([]);
  });

  it('drops skill and hook text that carries a source marker', () => {
    expect(steerEventParts([
      { type: 'text', text: 'skill instructions', meta: { source: 'skill activation' } },
      { type: 'text', text: 'check src/app.ts' },
      { type: 'text', text: 'hook note', meta: { source: 'user prompt submit hook' } },
      { type: 'image_url' },
    ])).toEqual({ texts: ['check src/app.ts'], hasMedia: true });
  });

  it('clears a steer when skill activation text is prepended', () => {
    const batch = { text: 'check src/app.ts', entries: ['check src/app.ts'] };
    const eventText = [
      'User activated the skill "review". Follow the loaded skill instructions.',
      '<skill-loaded name="review">',
      'Review the change.',
      '</skill-loaded>',
    ].join('\n') + 'check src/app.ts';
    const result = takeDeliveredSteerBatches([batch], eventText);
    expect(result.delivered).toEqual([batch]);
    expect(result.pending).toEqual([]);
  });
});
