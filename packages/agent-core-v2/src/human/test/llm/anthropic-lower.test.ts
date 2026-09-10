import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { providerImagePolicy } from '#/llm/media/image-formats';
import type { Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { lowerMessage } from '#/llm/requester/bases/anthropic/lower';
import { createAnthropicRequester } from '#/llm/requester/bases/anthropic/requester';
import type { LlmClientContext } from '#/llm/requester/requester';
import { kimiAnthropicTrait } from '#/llm-kimi/trait';

const routedModel: LlmModel = {
  provider: 'anthropic',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};

const HEIC_URL = 'data:image/heic;base64,AAAA';

const message: Message = {
  role: 'user',
  content: [{ type: 'image_url', imageUrl: { url: HEIC_URL } }],
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
  return {
    clientFactory: () =>
      ({
        messages: {
          create: (params: Record<string, unknown>) => {
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
          },
        },
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

  it('refuses a base64 image outside the baseline set when no trait widens it', () => {
    expect(() => lowerMessage(message, providerImagePolicy().acceptedMimes)).toThrow(
      /Unsupported media type for base64 image: image\/heic/,
    );
  });

  it('sends the HEIC block on the wire when Kimi is reached over the Anthropic protocol', async () => {
    const client = stubAnthropicClient();
    const requester = createAnthropicRequester({
      trait: kimiAnthropicTrait,
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
