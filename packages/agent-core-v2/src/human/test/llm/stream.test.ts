import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import type { FinishInfo } from '#/llm/finish-reason';
import { createUserMessage, type Message, type StreamedMessagePart } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { LlmClientContext, LlmRequestEvent } from '#/llm/requester/requester';
import { createAnthropicRequester } from '#/llm/requester/bases/anthropic/requester';
import { createGoogleGenAIRequester } from '#/llm/requester/bases/google-genai/requester';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import { createOpenAIResponsesRequester } from '#/llm/requester/bases/openai-responses/requester';
import type { TokenUsage } from '#/llm/usage';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};
const genaiModel: LlmModel = { ...model, apiKey: 'test-key' };
const messages: readonly Message[] = [createUserMessage('hi')];

const chatCompletion: Record<string, unknown> = {
  id: 'chatcmpl-1',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'hi',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'snap', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const anthropicMessage: Record<string, unknown> = {
  id: 'msg_1',
  content: [
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'toolu_1', name: 'snap', input: { a: 1 } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

const responsesBody: Record<string, unknown> = {
  id: 'resp_1',
  status: 'completed',
  output: [
    { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'snap', arguments: '{"a":1}' },
    {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'thinking' }],
      encrypted_content: 'enc-1',
    },
  ],
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
};

const genaiBody: Record<string, unknown> = {
  responseId: 'genai-1',
  candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
};

interface ClientStub {
  clientFactory: (request: LlmClientContext) => never;
  body: () => Record<string, unknown>;
  method: () => string | undefined;
}

function createClientStub(client: (captured: { method: string; params: Record<string, unknown> }[]) => unknown): ClientStub {
  const captured: { method: string; params: Record<string, unknown> }[] = [];
  return {
    clientFactory: () => client(captured) as never,
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last.params;
    },
    method: () => captured.at(-1)?.method,
  };
}

function withResponseBody(data: Record<string, unknown>): {
  withResponse: () => Promise<{ data: Record<string, unknown>; response: Response }>;
} {
  return {
    withResponse: async () => ({ data, response: new Response(null) }),
  };
}

function stubOpenAIClient(body: Record<string, unknown>): ClientStub {
  return createClientStub((captured) => ({
    chat: {
      completions: {
        create: (params: Record<string, unknown>) => {
          captured.push({ method: 'chat.completions.create', params });
          return withResponseBody(body);
        },
      },
    },
  }));
}

function stubResponsesClient(body: Record<string, unknown>): ClientStub {
  return createClientStub((captured) => ({
    responses: {
      create: (params: Record<string, unknown>) => {
        captured.push({ method: 'responses.create', params });
        return withResponseBody(body);
      },
    },
  }));
}

function stubAnthropicClient(body: Record<string, unknown>): ClientStub {
  return createClientStub((captured) => ({
    messages: {
      create: (params: Record<string, unknown>) => {
        captured.push({ method: 'messages.create', params });
        return withResponseBody(body);
      },
    },
  }));
}

function stubGoogleClient(body: Record<string, unknown>): ClientStub {
  return createClientStub((captured) => ({
    models: {
      generateContent: async (params: Record<string, unknown>) => {
        captured.push({ method: 'generateContent', params });
        return body;
      },
      generateContentStream: async (params: Record<string, unknown>) => {
        captured.push({ method: 'generateContentStream', params });
        throw new Error('expected non-streaming generateContent');
      },
    },
  }));
}

function partsOf(events: readonly LlmRequestEvent[]): StreamedMessagePart[] {
  return events.flatMap((event) => (event.type === 'llm.streaming.part' ? [event.part] : []));
}

function usagesOf(events: readonly LlmRequestEvent[]): Partial<TokenUsage>[] {
  return events.flatMap((event) => (event.type === 'llm.streaming.usage' ? [event.usage] : []));
}

function finishesOf(events: readonly LlmRequestEvent[]): FinishInfo[] {
  return events.flatMap((event) => (event.type === 'llm.streaming.finish' ? [event.finish] : []));
}

function messageIdsOf(events: readonly LlmRequestEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'llm.streaming.message_id' ? [event.messageId] : [],
  );
}

async function generateNonStream(
  requester: { generate: (...args: never[]) => Promise<void> },
  requestModel: LlmModel,
): Promise<LlmRequestEvent[]> {
  const events: LlmRequestEvent[] = [];
  await requester.generate(
    { model: requestModel, stream: false },
    { messages },
    { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
  );
  return events;
}

describe('openai requester stream=false', () => {
  it('sends a non-streaming request and emits the completion as the same event sequence', async () => {
    const client = stubOpenAIClient(chatCompletion);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    const events = await generateNonStream(requester, model);

    expect(client.body()['stream']).toBe(false);
    expect(client.body()['stream_options']).toBeUndefined();
    expect(messageIdsOf(events)).toEqual(['chatcmpl-1']);
    expect(partsOf(events)).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'function', id: 'call_1', name: 'snap', arguments: '{}' },
    ]);
    expect(usagesOf(events)).toEqual([
      {
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        raw: chatCompletion['usage'],
      },
    ]);
    expect(finishesOf(events)).toEqual([
      { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' },
    ]);
    expect(events.at(-1)?.type).toBe('llm.done');
  });
});

describe('anthropic requester stream=false', () => {
  it('sends a non-streaming request and emits the message as the same event sequence', async () => {
    const client = stubAnthropicClient(anthropicMessage);
    const requester = createAnthropicRequester({ clientFactory: client.clientFactory });
    const events = await generateNonStream(requester, model);

    expect(client.body()['stream']).toBe(false);
    expect(messageIdsOf(events)).toEqual(['msg_1']);
    expect(partsOf(events)).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'function', id: 'toolu_1', name: 'snap', arguments: '', _streamIndex: 1 },
      { type: 'tool_call_part', argumentsPart: '{"a":1}', index: 1 },
    ]);
    expect(usagesOf(events)).toEqual([
      { inputOther: 10, raw: anthropicMessage['usage'] },
      { inputOther: 10, output: 5, raw: anthropicMessage['usage'] },
    ]);
    expect(finishesOf(events)).toEqual([
      { finishReason: 'tool_calls', rawFinishReason: 'tool_use' },
    ]);
    expect(events.at(-1)?.type).toBe('llm.done');
  });
});

describe('openai-responses requester stream=false', () => {
  it('sends a non-streaming request and emits the response as the same event sequence', async () => {
    const client = stubResponsesClient(responsesBody);
    const requester = createOpenAIResponsesRequester({ clientFactory: client.clientFactory });
    const events = await generateNonStream(requester, model);

    expect(client.body()['stream']).toBe(false);
    expect(messageIdsOf(events)).toEqual(['resp_1']);
    expect(partsOf(events)).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'function', id: 'call_1', name: 'snap', arguments: '{"a":1}', _streamIndex: 'fc_1' },
      { type: 'think', think: '' },
      { type: 'think', think: 'thinking' },
      { type: 'think', think: '', encrypted: 'enc-1' },
    ]);
    expect(usagesOf(events)).toEqual([
      {
        inputOther: 1,
        output: 2,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        raw: responsesBody['usage'],
      },
    ]);
    expect(finishesOf(events)).toEqual([
      { finishReason: 'completed', rawFinishReason: 'completed' },
    ]);
    expect(events.at(-1)?.type).toBe('llm.done');
  });
});

describe('google-genai requester stream=false', () => {
  it('calls generateContent and emits the response as the same event sequence', async () => {
    const client = stubGoogleClient(genaiBody);
    const requester = createGoogleGenAIRequester({ clientFactory: client.clientFactory });
    const events = await generateNonStream(requester, genaiModel);

    expect(client.method()).toBe('generateContent');
    expect(messageIdsOf(events)).toEqual(['genai-1']);
    expect(partsOf(events)).toEqual([{ type: 'text', text: 'hi' }]);
    expect(usagesOf(events)).toEqual([
      {
        inputOther: 1,
        output: 1,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        raw: genaiBody['usageMetadata'],
      },
    ]);
    expect(finishesOf(events)).toEqual([{ finishReason: 'completed', rawFinishReason: 'STOP' }]);
    expect(events.at(-1)?.type).toBe('llm.done');
  });
});
