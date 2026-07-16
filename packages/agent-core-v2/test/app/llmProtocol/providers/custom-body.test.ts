/**
 * Scenario: provider custom-body patches preserve user-requested request semantics.
 * Exercises real provider adapters with only their SDK client boundary stubbed.
 * Run: pnpm exec vitest run packages/agent-core-v2/test/app/llmProtocol/providers/custom-body.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { Message } from '#/app/llmProtocol/message';
import { AnthropicChatProvider } from '#/app/llmProtocol/providers/anthropic';
import { GoogleGenAIChatProvider } from '#/app/llmProtocol/providers/google-genai';
import { KimiChatProvider } from '#/app/llmProtocol/providers/kimi';
import { OpenAILegacyChatProvider } from '#/app/llmProtocol/providers/openai-legacy';
import { OpenAIResponsesChatProvider } from '#/app/llmProtocol/providers/openai-responses';
import {
  applyCustomBody,
  resolveCustomBodyStream,
  type CustomBody,
} from '#/app/llmProtocol/providers/custom-body';

const HISTORY: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'generated input' }], toolCalls: [] },
];

const CHAT_PATCH: CustomBody = {
  model: 'configured-model',
  stream: false,
  messages: [],
  input: [],
  tools: null,
  nested: { enabled: false, retries: 0, empty: '', nullable: null, items: ['replacement'] },
};

function chatCompletionResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  };
}

function anthropicResponse(): Record<string, unknown> {
  return {
    id: 'msg-test',
    content: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

async function collect(message: AsyncIterable<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of message) {
    parts.push(part);
  }
  return parts;
}

async function* chatCompletionStream(): AsyncIterable<Record<string, unknown>> {
  yield {
    id: 'chatcmpl-stream-test',
    choices: [{ delta: { content: 'streamed' }, finish_reason: 'stop' }],
  };
}

async function* anthropicStream(): AsyncIterable<Record<string, unknown>> {
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streamed' } };
}

describe('applyCustomBody', () => {
  it('deep-merges object fields, replaces arrays and scalar values, and clones both inputs', () => {
    const generated = {
      model: 'generated-model',
      nested: { generated: { value: 1 }, replaced: ['generated'] },
    };
    const customBody: CustomBody = {
      model: 'configured-model',
      nested: {
        generated: { configured: true },
        replaced: ['configured'],
        falseValue: false,
        zeroValue: 0,
        emptyValue: '',
        nullValue: null,
      },
    };

    const result = applyCustomBody(generated, customBody);

    expect(result).toEqual({
      model: 'configured-model',
      nested: {
        generated: { value: 1, configured: true },
        replaced: ['configured'],
        falseValue: false,
        zeroValue: 0,
        emptyValue: '',
        nullValue: null,
      },
    });

    (result['nested'] as Record<string, unknown>)['replaced'] = ['mutated'];
    expect(generated.nested.replaced).toEqual(['generated']);
    expect(customBody['nested']).toMatchObject({ replaced: ['configured'] });
  });

  it('returns a detached clone when customBody is absent', () => {
    const generated = { contents: [{ role: 'user', parts: [{ text: 'generated' }] }] };
    const result = applyCustomBody(generated, undefined);

    ((result['contents'] as Array<Record<string, unknown>>)[0]!)['role'] = 'model';
    expect(generated.contents[0]?.role).toBe('user');
  });

  it('preserves an own __proto__ patch key without changing the result prototype', () => {
    const customBody = JSON.parse('{"__proto__":{"enabled":true}}') as CustomBody;
    const result = applyCustomBody({}, customBody);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(JSON.stringify(result)).toBe('{"__proto__":{"enabled":true}}');
  });
});

describe('resolveCustomBodyStream', () => {
  it('uses a boolean custom-body stream value instead of the provider default', () => {
    expect(resolveCustomBodyStream({ stream: true }, false)).toBe(true);
    expect(resolveCustomBodyStream({ stream: false }, true)).toBe(false);
  });
});

describe('v2 provider custom-body serialization', () => {
  it('returns non-stream text when customBody disables OpenAI Chat Completions streaming', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAILegacyChatProvider({
      model: 'generated-model',
      apiKey: '',
      customBody: CHAT_PATCH,
      clientFactory: () =>
        ({
          chat: {
            completions: {
              create(params: unknown) {
                body = params as Record<string, unknown>;
                return Promise.resolve(chatCompletionResponse());
              },
            },
          },
        }) as never,
    });

    const parts = await collect(await provider.generate('generated system', [], HISTORY));

    expect(body).toMatchObject({ model: 'configured-model', stream: false, messages: [], tools: null });
    expect(body?.['nested']).toEqual(CHAT_PATCH['nested']);
    expect(body).not.toHaveProperty('stream_options');
    expect(parts).toContainEqual({ type: 'text', text: 'ok' });
  });

  it('sends the patched OpenAI Responses request when customBody disables streaming', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIResponsesChatProvider({
      model: 'generated-model',
      apiKey: '',
      customBody: CHAT_PATCH,
      clientFactory: () =>
        ({
          responses: {
            create(params: unknown) {
              body = params as Record<string, unknown>;
              return Promise.resolve({ id: 'resp-test', output: [], status: 'completed' });
            },
          },
        }) as never,
    });

    await collect(await provider.generate('generated system', [], HISTORY));

    expect(body).toMatchObject({ model: 'configured-model', stream: false, input: [], tools: null });
    expect(body?.['nested']).toEqual(CHAT_PATCH['nested']);
  });

  it('returns non-stream text when customBody disables Kimi Chat Completions streaming', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new KimiChatProvider({
      model: 'generated-model',
      apiKey: '',
      customBody: CHAT_PATCH,
      clientFactory: () =>
        ({
          chat: {
            completions: {
              create(params: unknown) {
                body = params as Record<string, unknown>;
                return {
                  withResponse: () =>
                    Promise.resolve({ data: chatCompletionResponse(), response: new Response() }),
                };
              },
            },
          },
        }) as never,
    });

    const parts = await collect(await provider.generate('generated system', [], HISTORY));

    expect(body).toMatchObject({ model: 'configured-model', stream: false, messages: [], tools: null });
    expect(body?.['nested']).toEqual(CHAT_PATCH['nested']);
    expect(body).not.toHaveProperty('stream_options');
    expect(parts).toContainEqual({ type: 'text', text: 'ok' });
  });

  it('sends the patched Anthropic Messages request when customBody disables streaming', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new AnthropicChatProvider({
      model: 'generated-model',
      apiKey: '',
      customBody: CHAT_PATCH,
      clientFactory: () =>
        ({
          messages: {
            create(params: unknown) {
              body = params as Record<string, unknown>;
              return Promise.resolve(anthropicResponse());
            },
          },
        }) as never,
    });

    await collect(await provider.generate('generated system', [], HISTORY));

    expect(body).toMatchObject({ model: 'configured-model', stream: false, messages: [], tools: null });
    expect(body?.['nested']).toEqual(CHAT_PATCH['nested']);
  });

  it('selects non-stream Google GenAI generation when customBody disables streaming', async () => {
    let body: Record<string, unknown> | undefined;
    const customBody: CustomBody = {
      model: 'configured-model',
      stream: false,
      contents: [],
      config: {
        systemInstruction: 'configured system',
        tools: null,
        nested: { enabled: false, values: ['replacement'], nullable: null },
      },
    };
    const provider = new GoogleGenAIChatProvider({
      model: 'generated-model',
      apiKey: '',
      customBody,
      clientFactory: () =>
        ({
          models: {
            generateContent(params: unknown) {
              body = params as Record<string, unknown>;
              return Promise.resolve({ candidates: [] });
            },
            generateContentStream() {
              throw new Error('expected non-stream generation');
            },
          },
        }) as never,
    });

    await collect(await provider.generate('generated system', [], HISTORY));

    expect(body).toMatchObject({ model: 'configured-model', contents: [] });
    expect(body?.['config']).toEqual(customBody['config']);
    expect(body).not.toHaveProperty('stream');
  });

  it('enables OpenAI Chat Completions streaming when customBody overrides a non-stream provider', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAILegacyChatProvider({
      model: 'generated-model',
      apiKey: '',
      stream: false,
      customBody: { stream: true },
      clientFactory: () =>
        ({
          chat: {
            completions: {
              create(params: unknown) {
                body = params as Record<string, unknown>;
                return chatCompletionStream();
              },
            },
          },
        }) as never,
    });

    const parts = await collect(await provider.generate('generated system', [], HISTORY));

    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(parts).toContainEqual({ type: 'text', text: 'streamed' });
  });

  it('enables Kimi Chat Completions streaming when customBody overrides a non-stream provider', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new KimiChatProvider({
      model: 'generated-model',
      apiKey: '',
      stream: false,
      customBody: { stream: true },
      clientFactory: () =>
        ({
          chat: {
            completions: {
              create(params: unknown) {
                body = params as Record<string, unknown>;
                return {
                  withResponse: () =>
                    Promise.resolve({ data: chatCompletionStream(), response: new Response() }),
                };
              },
            },
          },
        }) as never,
    });

    const parts = await collect(await provider.generate('generated system', [], HISTORY));

    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(parts).toContainEqual({ type: 'text', text: 'streamed' });
  });

  it('enables Anthropic Messages streaming when customBody overrides a non-stream provider', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new AnthropicChatProvider({
      model: 'generated-model',
      apiKey: '',
      stream: false,
      customBody: { stream: true },
      clientFactory: () =>
        ({
          messages: {
            create(params: unknown) {
              body = params as Record<string, unknown>;
              return Promise.resolve(anthropicStream());
            },
          },
        }) as never,
    });

    const parts = await collect(await provider.generate('generated system', [], HISTORY));

    expect(body).toMatchObject({ stream: true });
    expect(parts).toContainEqual({ type: 'text', text: 'streamed' });
  });

  it('selects Google GenAI streaming when customBody overrides a non-stream provider', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new GoogleGenAIChatProvider({
      model: 'generated-model',
      apiKey: '',
      stream: false,
      customBody: { stream: true },
      clientFactory: () =>
        ({
          models: {
            generateContent() {
              throw new Error('expected streaming generation');
            },
            generateContentStream(params: unknown) {
              body = params as Record<string, unknown>;
              return Promise.resolve(chatCompletionStream());
            },
          },
        }) as never,
    });

    await collect(await provider.generate('generated system', [], HISTORY));

    expect(body).not.toHaveProperty('stream');
  });
});
