import { describe, expect, it, vi } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage, type Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { LlmRequester, LlmRequestEvent } from '#/llm/requester/requester';
import { LLM_HEADERS_TIMEOUT_ENV } from '#/llm/requester/timeout';
import { createAnthropicRequester } from '#/llm/requester/bases/anthropic/requester';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import { createOpenAIResponsesRequester } from '#/llm/requester/bases/openai-responses/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};
const messages: readonly Message[] = [createUserMessage('hi')];

const openAISse = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

const responsesSse = [
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
  '',
  '',
].join('\n');

const anthropicSse = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

async function generate(requester: LlmRequester): Promise<LlmRequestEvent[]> {
  const events: LlmRequestEvent[] = [];
  await requester.generate(
    { model },
    { messages },
    { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
  );
  return events;
}

describe('default client headers timeout', () => {
  it('passes the configured headers-timeout dispatcher to fetch and fails the request on invalid values', async () => {
    const proxyEnvKeys = [
      'http_proxy',
      'HTTP_PROXY',
      'https_proxy',
      'HTTPS_PROXY',
      'all_proxy',
      'ALL_PROXY',
      'no_proxy',
      'NO_PROXY',
    ];
    const savedEnv = Object.fromEntries(
      [LLM_HEADERS_TIMEOUT_ENV, ...proxyEnvKeys].map((key) => [key, process.env[key]]),
    );
    for (const key of [LLM_HEADERS_TIMEOUT_ENV, ...proxyEnvKeys]) delete process.env[key];
    let currentSse = openAISse;
    const fetchStub = vi.fn(
      async () =>
        new Response(currentSse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetchStub);
    try {
      const protocols = [
        { create: () => createOpenAIRequester(), sse: openAISse },
        { create: () => createOpenAIResponsesRequester(), sse: responsesSse },
        { create: () => createAnthropicRequester(), sse: anthropicSse },
      ];
      let calls = 0;
      for (const protocol of protocols) {
        currentSse = protocol.sse;
        let events = await generate(protocol.create());
        calls += 1;
        expect(events.at(-1)).toMatchObject({ type: 'llm.done' });
        expect(fetchStub).toHaveBeenCalledTimes(calls);
        expect(fetchStub.mock.calls[calls - 1]?.[1]).not.toHaveProperty('dispatcher');

        process.env[LLM_HEADERS_TIMEOUT_ENV] = '45000';
        events = await generate(protocol.create());
        calls += 1;
        expect(events.at(-1)).toMatchObject({ type: 'llm.done' });
        expect(fetchStub).toHaveBeenCalledTimes(calls);
        expect(fetchStub.mock.calls[calls - 1]?.[1]).toHaveProperty('dispatcher');
        delete process.env[LLM_HEADERS_TIMEOUT_ENV];
      }

      currentSse = openAISse;
      process.env[LLM_HEADERS_TIMEOUT_ENV] = '45000';
      process.env['HTTP_PROXY'] = 'http://127.0.0.1:3128';
      await generate(createOpenAIRequester());
      calls += 1;
      expect(fetchStub).toHaveBeenCalledTimes(calls);
      expect(fetchStub.mock.calls[calls - 1]?.[1]).toHaveProperty('dispatcher');
      delete process.env['HTTP_PROXY'];

      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      await generate(createOpenAIRequester());
      calls += 1;
      expect(fetchStub).toHaveBeenCalledTimes(calls);
      expect(fetchStub.mock.calls[calls - 1]?.[1]).not.toHaveProperty('dispatcher');
      delete process.env['ALL_PROXY'];

      process.env[LLM_HEADERS_TIMEOUT_ENV] = 'abc';
      const events = await generate(createOpenAIRequester());
      expect(events.at(-1)).toMatchObject({
        type: 'llm.failed.remote',
        error: { message: expect.stringContaining(LLM_HEADERS_TIMEOUT_ENV) },
      });
    } finally {
      vi.unstubAllGlobals();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
