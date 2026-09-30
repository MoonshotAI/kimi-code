import { describe, expect, it } from 'vitest';

import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  type Message,
} from '#/llm/message';
import type { LlmModelSpec, ResponseFormat } from '#/llm/request';
import { createRequester } from '#/llm/requester';
import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';
import { extractToolText, openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import {
  extractToolText as extractResponsesToolText,
  openAIResponsesProtocol,
} from '#/llm/builtin/protocol/openai-responses/index';

const spec: LlmModelSpec = {
  provider: 'test',
  name: 'test-model',
};
const messages: readonly Message[] = [createUserMessage('hi')];
const control = () => ({ signal: new AbortController().signal });

const jsonObjectFormat: ResponseFormat = { type: 'json_object' };
const jsonSchemaFormat: ResponseFormat = {
  type: 'json_schema',
  jsonSchema: {
    name: 'answer',
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    strict: true,
    description: 'structured answer',
  },
};

const chatCompletionChunks: readonly Record<string, unknown>[] = [
  {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  },
];

const anthropicStreamEvents: readonly Record<string, unknown>[] = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];

const responsesStreamEvents: readonly Record<string, unknown>[] = [
  { type: 'response.output_text.delta', delta: 'ok' },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  },
];

const googleGenAIStreamChunks: readonly Record<string, unknown>[] = [
  {
    candidates: [
      { content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  },
];

function createAsyncStream<T>(chunks: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

interface ClientStub {
  clientFactory: () => unknown;
  body: () => Record<string, unknown>;
  called: () => boolean;
}

function createClientStub(
  client: (captured: Record<string, unknown>[]) => unknown,
): ClientStub {
  const captured: Record<string, unknown>[] = [];
  return {
    clientFactory: () => client(captured),
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
    called: () => captured.length > 0,
  };
}

function withResponseStream(chunks: readonly Record<string, unknown>[]): {
  withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>>; response: Response }>;
} {
  return {
    withResponse: async () => ({
      data: createAsyncStream(chunks),
      response: new Response(null),
    }),
  };
}

function stubOpenAIClient(chunks: readonly Record<string, unknown>[]): ClientStub {
  return createClientStub((captured) => ({
    chat: {
      completions: {
        create: (params: Record<string, unknown>) => {
          captured.push(params);
          return withResponseStream(chunks);
        },
      },
    },
  }));
}

function stubResponsesClient(events: readonly Record<string, unknown>[]): ClientStub {
  return createClientStub((captured) => ({
    responses: {
      create: (params: Record<string, unknown>) => {
        captured.push(params);
        return withResponseStream(events);
      },
    },
  }));
}

function stubAnthropicClient(events: readonly Record<string, unknown>[]): ClientStub {
  return createClientStub((captured) => ({
    messages: {
      create: (params: Record<string, unknown>) => {
        captured.push(params);
        return withResponseStream(events);
      },
    },
  }));
}

function stubGoogleClient(chunks: readonly Record<string, unknown>[]): ClientStub {
  return createClientStub((captured) => ({
    models: {
      generateContentStream: async (params: Record<string, unknown>) => {
        captured.push(params);
        return createAsyncStream(chunks);
      },
    },
  }));
}

describe('openai requester responseFormat', () => {
  it('maps json_object to response_format', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createRequester().with({
      protocol: { base: openAIProtocol },
      endpoint: { clientFactory: client.clientFactory },
    });
    await requester.generate(
      { model: { spec, responseFormat: jsonObjectFormat }, content: { messages } },
      control(),
    );
    expect(client.body()['response_format']).toEqual({ type: 'json_object' });
  });

  it('maps json_schema to response_format.json_schema', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createRequester().with({
      protocol: { base: openAIProtocol },
      endpoint: { clientFactory: client.clientFactory },
    });
    await requester.generate(
      { model: { spec, responseFormat: jsonSchemaFormat }, content: { messages } },
      control(),
    );
    expect(client.body()['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        schema: jsonSchemaFormat.jsonSchema.schema,
        strict: true,
        description: 'structured answer',
      },
    });
  });
});

describe('openai-responses requester responseFormat', () => {
  it('maps json_schema to text.format', async () => {
    const client = stubResponsesClient(responsesStreamEvents);
    const requester = createRequester().with({
      protocol: {
        base: openAIResponsesProtocol,
        options: { extras: { text: { verbosity: 'high' }, reasoning: { summary: 'detailed' } } },
      },
      endpoint: { clientFactory: client.clientFactory },
    });
    await requester.generate(
      {
        model: { spec, responseFormat: jsonSchemaFormat, thinking: { effort: 'high' } },
        content: { messages },
      },
      control(),
    );
    expect(client.body()['text']).toEqual({
      format: {
        type: 'json_schema',
        name: 'answer',
        schema: jsonSchemaFormat.jsonSchema.schema,
        strict: true,
        description: 'structured answer',
      },
      verbosity: 'high',
    });
    expect(client.body()['reasoning']).toEqual({ effort: 'high', summary: 'detailed' });
  });
});

describe('anthropic requester responseFormat', () => {
  it('maps json_schema to output_config.format and keeps the thinking effort', async () => {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createRequester().with({
      protocol: { base: anthropicProtocol },
      endpoint: { clientFactory: client.clientFactory },
    });
    await requester.generate(
      {
        model: { spec, thinking: { effort: 'high' }, responseFormat: jsonSchemaFormat },
        content: { messages },
      },
      control(),
    );
    expect(client.body()['output_config']).toEqual({
      effort: 'high',
      format: { type: 'json_schema', schema: jsonSchemaFormat.jsonSchema.schema },
    });
  });

  it('fails with a syntax error for json_object', async () => {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createRequester().with({
      protocol: { base: anthropicProtocol },
      endpoint: { clientFactory: client.clientFactory },
    });
    const result = await requester.generate(
      { model: { spec, responseFormat: jsonObjectFormat }, content: { messages } },
      control(),
    );
    expect(client.called()).toBe(false);
    if (result.type !== 'failed' || result.error.kind !== 'syntax') {
      throw new Error('expected a syntax failure');
    }
    expect(result.error.code).toBe('request_format');
  });
});

describe('google-genai requester responseFormat', () => {
  it('maps response formats to config', async () => {
    const client = stubGoogleClient(googleGenAIStreamChunks);
    const requester = createRequester().with({
      protocol: { base: googleGenAIProtocol },
      endpoint: { clientFactory: client.clientFactory },
      model: { spec },
      content: { messages },
    });
    await requester.generate({ model: { responseFormat: jsonSchemaFormat } }, control());
    let config = client.body()['config'] as Record<string, unknown> | undefined;
    expect(config?.['responseMimeType']).toBe('application/json');
    expect(config?.['responseJsonSchema']).toEqual(jsonSchemaFormat.jsonSchema.schema);

    await requester.generate({ model: { responseFormat: jsonObjectFormat } }, control());
    config = client.body()['config'] as Record<string, unknown> | undefined;
    expect(config?.['responseMimeType']).toBe('application/json');
    expect(config?.['responseJsonSchema']).toBeUndefined();
  });
});

describe('requester toolMessageConversion', () => {
  it('forces tool results to plain text when set to extract_text', async () => {
    const toolMessages: readonly Message[] = [
      createUserMessage('hi'),
      createAssistantMessage([], [
        { type: 'function', id: 'call_1', name: 'snap', arguments: '{}' },
      ]),
      createToolMessage('call_1', [
        { type: 'text', text: 'shot taken' },
        { type: 'image_url', source: { kind: 'url', url: 'https://example.test/shot.png' } },
      ]),
    ];
    const expectedText = 'shot taken\n[image omitted: not supported by this provider]';
    const conversation = createRequester().with({
      model: { spec: { provider: 'test', name: 'gpt-4o-mini' } },
      content: { messages: toolMessages },
    });

    const openAIClient = stubOpenAIClient(chatCompletionChunks);
    await conversation.generate(
      {
        protocol: { base: openAIProtocol.with(extractToolText) },
        endpoint: { clientFactory: openAIClient.clientFactory },
      },
      control(),
    );
    const chatMessages = openAIClient.body()['messages'] as Record<string, unknown>[];
    expect(chatMessages.find((message) => message['role'] === 'tool')?.['content']).toBe(
      expectedText,
    );
    expect(chatMessages.filter((message) => message['role'] === 'user')).toHaveLength(1);
    expect(JSON.stringify(chatMessages)).not.toContain('image_url');

    const responsesClient = stubResponsesClient(responsesStreamEvents);
    await conversation.generate(
      {
        protocol: { base: openAIResponsesProtocol.with(extractResponsesToolText) },
        endpoint: { clientFactory: responsesClient.clientFactory },
      },
      control(),
    );
    const inputItems = responsesClient.body()['input'] as Record<string, unknown>[];
    expect(
      inputItems.find((item) => item['type'] === 'function_call_output')?.['output'],
    ).toBe(expectedText);
    expect(JSON.stringify(inputItems)).not.toContain('input_image');
  });
});
