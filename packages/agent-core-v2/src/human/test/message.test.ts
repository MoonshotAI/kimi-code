import { describe, expect, it } from 'vitest';

import { createMessageAccumulator, fromCorePart, toCorePart } from '#/message';

describe('core message conversion', () => {
  it('preserves MIME parameters on media data URLs', () => {
    const url = 'data:video/mp4;codecs=avc1;base64,AQID';
    const core = toCorePart({ type: 'video_url', videoUrl: { url } });
    const legacy = fromCorePart(core);
    if (legacy.type !== 'video_url') throw new Error('expected a video part');
    expect(legacy.videoUrl.url).toBe(url);
  });
});

describe('message accumulator', () => {
  it('merges extras into a pending tool call', () => {
    const accumulator = createMessageAccumulator();
    accumulator.push({
      type: 'function',
      id: 'call_1',
      name: 'weather',
      arguments: '{}',
      _streamIndex: 0,
    });
    accumulator.push({
      type: 'tool_call_part',
      argumentsPart: null,
      index: 0,
      extras: { extra_content: { google: { thought_signature: 'sig-tool' } } },
    });
    expect(accumulator.finish().toolCalls[0]?.extras).toEqual({
      extra_content: { google: { thought_signature: 'sig-tool' } },
    });
  });

  it('merges extras into a flushed tool call', () => {
    const accumulator = createMessageAccumulator();
    accumulator.push({
      type: 'function',
      id: 'call_1',
      name: 'weather',
      arguments: '{}',
      _streamIndex: 0,
    });
    accumulator.push({ type: 'text', text: 'next' });
    accumulator.push({
      type: 'tool_call_part',
      argumentsPart: null,
      index: 0,
      extras: { extra_content: { google: { thought_signature: 'sig-tool' } } },
    });
    const message = accumulator.finish();
    expect(message.toolCalls[0]?.extras).toEqual({
      extra_content: { google: { thought_signature: 'sig-tool' } },
    });
    expect(message.content).toEqual([{ type: 'text', text: 'next' }]);
  });
});
