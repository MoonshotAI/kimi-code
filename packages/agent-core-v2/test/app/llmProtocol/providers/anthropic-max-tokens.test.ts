import { describe, expect, it, vi } from 'vitest';

import type { Message } from '#/app/llmProtocol/message';
import {
  AnthropicChatProvider,
  resolveDefaultMaxTokens,
} from '#/app/llmProtocol/providers/anthropic';

const HISTORY: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
];

function makeAnthropicResponse() {
  return {
    id: 'msg_test_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

async function captureRequestBody(
  provider: AnthropicChatProvider,
): Promise<Record<string, unknown>> {
  let capturedParams: Record<string, unknown> | undefined;

  (provider as unknown as { _client: { messages: { create: unknown } } })._client.messages.create =
    vi.fn().mockImplementation((params: unknown) => {
      capturedParams = params as Record<string, unknown>;
      return Promise.resolve(makeAnthropicResponse());
    });

  const stream = await provider.generate('', [], HISTORY);
  for await (const part of stream) void part;

  if (capturedParams === undefined) {
    throw new Error('Expected provider.generate() to call messages.create');
  }
  return capturedParams;
}

async function maxTokensFor(
  model: string,
  opts: Partial<{ defaultMaxTokens: number }> = {},
): Promise<number> {
  const provider = new AnthropicChatProvider({
    model,
    apiKey: 'test-key',
    stream: false,
    ...opts,
  });
  return (await captureRequestBody(provider))['max_tokens'] as number;
}

describe('resolveDefaultMaxTokens', () => {
  it('returns per-version Messages-API caps for known Claude 4 models', () => {
    expect(resolveDefaultMaxTokens('claude-fable-5')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-5-20251101')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-6')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-5')).toBe(64000);
  });

  it('matches dotted version separators', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4.8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4.7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4.6')).toBe(64000);
  });

  it('falls back to the nearest lower catalogued minor for unknown minors', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4-9')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-10')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-9')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-9')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-opus-4-3')).toBe(32000);
  });

  it('honors a lower override and clamps an override above the ceiling', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 200)).toBe(200);
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 999999)).toBe(128000);
  });

  it('honors the override for unknown models and falls back to 32000', () => {
    expect(resolveDefaultMaxTokens('unknown-model', 12345)).toBe(12345);
    expect(resolveDefaultMaxTokens('totally-unknown-model')).toBe(32000);
  });
});

describe('AnthropicChatProvider constructor max_tokens', () => {
  it('uses per-version Messages-API caps for known Claude models', async () => {
    expect(await maxTokensFor('claude-opus-4-8')).toBe(128000);
    expect(await maxTokensFor('claude-opus-4-7')).toBe(128000);
    expect(await maxTokensFor('claude-sonnet-4-6')).toBe(64000);
  });

  it('honors defaultMaxTokens for unknown models', async () => {
    expect(await maxTokensFor('unknown-model', { defaultMaxTokens: 4321 })).toBe(4321);
  });

  it('honors a lower defaultMaxTokens on known models', async () => {
    expect(await maxTokensFor('claude-opus-4-7', { defaultMaxTokens: 200 })).toBe(200);
  });

  it('honors explicit defaultMaxTokens above the ceiling for known models', async () => {
    expect(await maxTokensFor('claude-opus-4-7', { defaultMaxTokens: 999999 })).toBe(999999);
  });

  it('withMaxCompletionTokens preserves explicit defaultMaxTokens above the ceiling', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'test-key',
      stream: false,
      defaultMaxTokens: 999999,
    }).withMaxCompletionTokens(1024);
    const body = await captureRequestBody(provider);

    expect(body['max_tokens']).toBe(999999);
  });

  it('withMaxCompletionTokens clamps above the ceiling without an explicit override', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'test-key',
      stream: false,
    }).withMaxCompletionTokens(999999);
    const body = await captureRequestBody(provider);

    expect(body['max_tokens']).toBe(128000);
  });
});
