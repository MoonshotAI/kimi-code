import type { GenerateOptions, ResponseFormat } from '#/app/llmProtocol/provider';
import type { Message } from '#/app/llmProtocol/message';
import { AnthropicChatProvider } from '#/app/llmProtocol/providers/anthropic';
import { GoogleGenAIChatProvider } from '#/app/llmProtocol/providers/google-genai';
import { KimiChatProvider } from '#/app/llmProtocol/providers/kimi';
import { OpenAILegacyChatProvider } from '#/app/llmProtocol/providers/openai-legacy';
import { OpenAIResponsesChatProvider } from '#/app/llmProtocol/providers/openai-responses';
import { describe, expect, it, vi } from 'vitest';

const HISTORY: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Extract contact' }], toolCalls: [] },
];

const CONTACT_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
};

const JSON_SCHEMA_FORMAT: ResponseFormat = {
  type: 'json_schema',
  jsonSchema: {
    name: 'contact',
    schema: CONTACT_SCHEMA,
    strict: true,
  },
};

function chatCompletionResponse(model = 'test-model') {
  return {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    created: 1234567890,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function anthropicResponse(model = 'claude-test') {
  return {
    id: 'msg_test_123',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function googleResponse() {
  return {
    candidates: [
      {
        content: { parts: [{ text: 'Hello' }], role: 'model' },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
    modelVersion: 'gemini-2.5-flash',
  };
}

function responsesApiResponse() {
  return {
    id: 'resp_test123',
    object: 'response',
    created_at: 1234567890,
    status: 'completed',
    model: 'gpt-4.1',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

async function captureKimiBody(options?: GenerateOptions): Promise<Record<string, unknown>> {
  const provider = new KimiChatProvider({
    model: 'kimi-k2-turbo-preview',
    apiKey: 'test-key',
    stream: false,
  });
  let captured: Record<string, unknown> | undefined;
  (Reflect.get(provider, '_client') as { chat: { completions: { create: unknown } } }).chat.completions.create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return {
      withResponse: () =>
        Promise.resolve({
          data: chatCompletionResponse('kimi-k2'),
          response: new Response(null),
          request_id: null,
        }),
    };
  });

  const stream = await provider.generate('', [], HISTORY, options);
  for await (const part of stream) void part;
  if (captured === undefined) throw new Error('Expected Kimi provider to create a chat completion');
  return captured;
}

async function captureOpenAILegacyBody(options?: GenerateOptions): Promise<Record<string, unknown>> {
  const provider = new OpenAILegacyChatProvider({
    model: 'gpt-4.1',
    apiKey: 'test-key',
    stream: false,
  });
  let captured: Record<string, unknown> | undefined;
  (Reflect.get(provider, '_client') as { chat: { completions: { create: unknown } } }).chat.completions.create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve(chatCompletionResponse('gpt-4.1'));
  });

  const stream = await provider.generate('', [], HISTORY, options);
  for await (const part of stream) void part;
  if (captured === undefined) throw new Error('Expected OpenAI provider to create a chat completion');
  return captured;
}

async function captureAnthropicBody(
  provider: AnthropicChatProvider,
  options?: GenerateOptions,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  (Reflect.get(provider, '_client') as { messages: { create: unknown } }).messages.create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve(anthropicResponse());
  });

  const stream = await provider.generate('', [], HISTORY, options);
  for await (const part of stream) void part;
  if (captured === undefined) throw new Error('Expected Anthropic provider to create a message');
  return captured;
}

async function captureGoogleBody(
  provider: GoogleGenAIChatProvider,
  options?: GenerateOptions,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const client = Reflect.get(provider, '_client') as {
    models: { generateContent: unknown; generateContentStream: unknown };
  };
  client.models.generateContent = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve(googleResponse());
  });

  const stream = await provider.generate('', [], HISTORY, options);
  for await (const part of stream) void part;
  if (captured === undefined) throw new Error('Expected Google provider to generate content');
  return captured;
}

async function captureResponsesBody(
  provider: OpenAIResponsesChatProvider,
  options?: GenerateOptions,
): Promise<Record<string, unknown>> {
  Reflect.set(provider, '_stream', false);
  let captured: Record<string, unknown> | undefined;
  ((Reflect.get(provider, '_client') as { responses: { create: unknown } }).responses).create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve(responsesApiResponse());
  });

  const stream = await provider.generate('', [], HISTORY, options);
  for await (const part of stream) void part;
  if (captured === undefined) throw new Error('Expected Responses provider to create a response');
  return captured;
}

describe('structured response formats', () => {
  it('maps json_schema format to Kimi response_format', async () => {
    const body = await captureKimiBody({ responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
  });

  it('maps json_schema format to OpenAI Chat Completions response_format', async () => {
    const body = await captureOpenAILegacyBody({ responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
  });

  it('maps json_schema format to Anthropic output_config.format', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-test',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: false,
    }).withGenerationKwargs({ output_config: { effort: 'medium' } });

    const body = await captureAnthropicBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['output_config']).toEqual({
      effort: 'medium',
      format: {
        type: 'json_schema',
        schema: CONTACT_SCHEMA,
      },
    });
  });

  it('rejects json_object format for Anthropic because the provider requires a schema', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-test',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: false,
    });

    await expect(
      provider.generate('', [], HISTORY, {
        responseFormat: { type: 'json_object' },
      }),
    ).rejects.toThrow('Anthropic provider requires a JSON schema for structured response output.');
  });

  it('maps json_schema format to Google GenAI response config', async () => {
    const provider = new GoogleGenAIChatProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      stream: false,
    });

    const body = await captureGoogleBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });
    const config = body['config'] as Record<string, unknown>;

    expect(config['responseMimeType']).toBe('application/json');
    expect(config['responseJsonSchema']).toEqual(CONTACT_SCHEMA);
  });

  it('replaces conflicting native Google schema config when applying response format', async () => {
    const provider = new GoogleGenAIChatProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      stream: false,
    }).withGenerationKwargs({
      responseSchema: {
        type: 'object',
        properties: { old: { type: 'string' } },
      },
      responseJsonSchema: {
        type: 'object',
        properties: { older: { type: 'string' } },
      },
    });

    const body = await captureGoogleBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });
    const config = body['config'] as Record<string, unknown>;

    expect(config['responseSchema']).toBeUndefined();
    expect(config['responseJsonSchema']).toEqual(CONTACT_SCHEMA);
  });

  it('maps json_schema format to OpenAI Responses text.format', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-4.1', apiKey: 'test-key' });

    const body = await captureResponsesBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['text']).toEqual({
      format: {
        type: 'json_schema',
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
  });

  it('preserves existing OpenAI Responses text options when applying response format', async () => {
    const provider = new OpenAIResponsesChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
    }).withGenerationKwargs({
      text: { verbosity: 'low' },
    });

    const body = await captureResponsesBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['text']).toEqual({
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
  });
});
