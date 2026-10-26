import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { providerImagePolicy } from '#/llm/media/image-formats';
import type { Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { lowerMessage } from '#/llm/requester/bases/anthropic/lower';
import { createAnthropicRequester } from '#/llm/requester/bases/anthropic/requester';
import type { LlmClientContext } from '#/llm/requester/requester';
import { kimiAnthropicTrait } from '#/llm-kimi/trait';
import { foldV2WireRecords } from '#/persist/v2/fold';
import type { V2WireRecord } from '#/persist/v2/wire';

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

describe('anthropic lowering of tool results', () => {
  const MIMES = providerImagePolicy().acceptedMimes;

  function lowerToolResult(content: Message['content']): Record<string, unknown> {
    const toolMessage: Message = { role: 'tool', toolCallId: 'call_1', content, toolCalls: [] };
    const wire = lowerMessage(toolMessage, MIMES);
    const block = (wire[0]?.content as Record<string, unknown>[])[0];
    expect(block?.['type']).toBe('tool_result');
    return block as Record<string, unknown>;
  }

  it('keeps a video-only tool result as a video block without adding a text anchor', () => {
    const block = lowerToolResult([
      { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } },
    ]);
    expect(block['content']).toEqual([
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' } },
    ]);
  });

  it('passes an ms:// video url through as a url source', () => {
    const block = lowerToolResult([
      { type: 'video_url', videoUrl: { url: 'ms://file-id-123' } },
    ]);
    expect(block['content']).toEqual([
      { type: 'video', source: { type: 'url', url: 'ms://file-id-123' } },
    ]);
  });

  it('keeps text around a video without extra blocks', () => {
    const block = lowerToolResult([
      { type: 'text', text: '<video path="/tmp/a.mp4">' },
      { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } },
      { type: 'text', text: '</video>' },
    ]);
    expect(block['content']).toEqual([
      { type: 'text', text: '<video path="/tmp/a.mp4">' },
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' } },
      { type: 'text', text: '</video>' },
    ]);
  });

  it('fills an empty tool result with placeholder text instead of empty content', () => {
    const block = lowerToolResult([]);
    expect(block['content']).toEqual([{ type: 'text', text: 'Tool output is empty.' }]);
  });

  it('fills a tool result whose only text is empty with placeholder text', () => {
    const block = lowerToolResult([{ type: 'text', text: '' }]);
    expect(block['content']).toEqual([{ type: 'text', text: 'Tool output is empty.' }]);
  });
});

describe('anthropic lowering of folded wire history', () => {
  function badToolResultRecords(output: unknown): V2WireRecord[] {
    const loopEvent = (event: Record<string, unknown>): V2WireRecord =>
      ({ type: 'context.append_loop_event', agentId: 'main', time: 1, event }) as V2WireRecord;
    return [
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '0' }),
      loopEvent({
        type: 'tool.call',
        stepUuid: 's1',
        toolCallId: 'call_1',
        name: 'ReadMediaFile',
        args: { path: 'a.mp4' },
      }),
      loopEvent({ type: 'tool.result', toolCallId: 'call_1', result: { output } }),
      loopEvent({ type: 'step.end', uuid: 's1', finishReason: 'tool_calls' }),
    ];
  }

  it.each([
    ['a non-array object', { unexpected: 'shape' }],
    ['an empty array', []],
    ['null', null],
  ])(
    'self-heals a persisted tool.result whose output is %s',
    async (_label, output) => {
      const folded = foldV2WireRecords(badToolResultRecords(output));
      const toolMessage = folded.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toEqual([]);

      const client = stubAnthropicClient();
      const requester = createAnthropicRequester({ clientFactory: client.clientFactory });
      await requester.generate(
        { model: routedModel },
        { messages: folded.messages },
        { signal: new AbortController().signal },
      );
      const messages = client.body()['messages'] as { content: Record<string, unknown>[] }[];
      const toolResult = messages
        .flatMap((message) => message.content)
        .find((block) => block['type'] === 'tool_result');
      expect(toolResult?.['content']).toEqual([{ type: 'text', text: 'Tool output is empty.' }]);
    },
  );
});
