import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm-requester/capability';
import { providerImagePolicy } from '#/llm/protocol/kit/media';
import type { Message } from '#/llm/message';
import { fromCorePart, toCorePart } from '#/message';
import type { LlmModel } from '#/llm-requester/model';
import { createKimiAnthropicRequester } from '#/llm-requester/factories';
import { lowerMessage } from '#/llm/builtin/protocol/anthropic/lower';
import type { LlmClientContext } from '#/llm-requester/requester';

const routedModel: LlmModel = {
  provider: 'anthropic',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};

const message: Message = {
  role: 'user',
  content: [{ type: 'image_url', imageUrl: { url: 'data:image/heic;base64,AAAA' } }],
};

const HEIC_BLOCK = {
  type: 'image',
  source: { type: 'base64', data: 'AAAA', media_type: 'image/heic' },
};

function stubAnthropicClient(): {
  clientFactory: (request: LlmClientContext) => never;
  body: () => Record<string, unknown>;
} {
  const captured: Record<string, unknown>[] = [];
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  const create = (params: Record<string, unknown>) => {
    captured.push(params);
    return {
      withResponse: async () => ({
        data: {
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
          },
        },
        response: new Response(null),
      }),
    };
  };
  return {
    clientFactory: () =>
      ({
        messages: { create },
        beta: { messages: { create } },
      }) as never,
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

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

  it('sends the HEIC block on the wire when Kimi is reached over the Anthropic protocol', async () => {
    const client = stubAnthropicClient();
    const requester = createKimiAnthropicRequester({
      clientFactory: client.clientFactory,
    });
    await requester.generate(
      { model: routedModel },
      { messages: [message] },
      { signal: new AbortController().signal },
    );
    const messages = client.body()['messages'] as { content: unknown[] }[];
    expect(messages[0]?.content[0]).toMatchObject(HEIC_BLOCK);
  });
});
