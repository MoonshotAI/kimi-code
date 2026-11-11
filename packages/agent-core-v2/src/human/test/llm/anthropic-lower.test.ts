import { describe, expect, it } from 'vitest';

import { providerImagePolicy } from '@moonshot-ai/core/llm/protocol/kit/media';
import type { Message } from '@moonshot-ai/core/llm/message';
import { fromCorePart, toCorePart } from '#/message';
import { lowerMessage } from '@moonshot-ai/core/llm/builtin/protocol/anthropic/lower';

const message: Message = {
  role: 'user',
  content: [{ type: 'image_url', imageUrl: { url: 'data:image/heic;base64,AAAA' } }],
};

const HEIC_BLOCK = {
  type: 'image',
  source: { type: 'base64', data: 'AAAA', media_type: 'image/heic' },
};

describe('anthropic lowering of inline images', () => {
  it('forwards a base64 image the Kimi policy accepts even though the route id is anthropic', () => {
    const wire = lowerMessage(message, providerImagePolicy('kimi').acceptedMimes);
    expect(wire[0]?.content[0]).toEqual(HEIC_BLOCK);
  });

  it('refuses unsupported base64 media without dropping MIME parameters', () => {
    expect(() => lowerMessage(message, providerImagePolicy().acceptedMimes)).toThrow(
      /Unsupported media type for base64 image: image\/heic/,
    );

    const url = 'data:video/mp4;codecs=avc1;base64,AQID';
    const core = toCorePart({ type: 'video_url', videoUrl: { url } });
    const legacy = fromCorePart(core);
    if (legacy.type !== 'video_url') throw new Error('expected a video part');
    expect(legacy.videoUrl.url).toBe(url);
    expect(() =>
      lowerMessage({ role: 'user', content: [core] }, providerImagePolicy().acceptedMimes),
    ).toThrow(/Unsupported media type for base64 video: video\/mp4;codecs=avc1/);
  });
});

describe('anthropic lowering of blank text', () => {
  it('omits blank text kept only for another provider signature', () => {
    const wire = lowerMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer', meta: { thought_signature_b64: 'sig-text' } },
        { type: 'text', text: '', meta: { thought_signature_b64: 'sig-end' } },
      ],
      toolCalls: [{ type: 'function', id: 'call_1', name: 'get_weather', arguments: '{}' }],
    });
    expect(wire[0]?.content).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} },
    ]);
  });
});
