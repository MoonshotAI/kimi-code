/**
 * `llmProtocol` domain (L0) — verifies Anthropic request limits and thinking profiles.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Message } from '#/app/llmProtocol/message';
import {
  AnthropicChatProvider,
  resolveDefaultMaxTokens,
} from '#/app/llmProtocol/providers/anthropic';
import { matchKnownAnthropicModelProfile } from '#/app/llmProtocol/providers/anthropic-profile';

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

describe('Anthropic model profile matching', () => {
  it.each([
    ['claude-opus-4-5', 'budget', ['low', 'medium', 'high'], true, true],
    ['anthropic.claude-opus-4-6-v1:0', 'adaptive', ['low', 'medium', 'high', 'max'], true, true],
    ['claude-opus-4-7', 'adaptive', ['low', 'medium', 'high', 'xhigh', 'max'], true, true],
    ['claude-sonnet-4-6', 'adaptive', ['low', 'medium', 'high', 'max'], true, true],
    ['claude-sonnet-5', 'adaptive', ['low', 'medium', 'high', 'xhigh', 'max'], true, true],
    ['claude-fable-5', 'adaptive', ['low', 'medium', 'high', 'xhigh', 'max'], true, false],
    ['claude-mythos-5', 'adaptive', ['low', 'medium', 'high', 'xhigh', 'max'], true, false],
    ['claude-mythos-preview', 'adaptive', ['low', 'medium', 'high', 'max'], true, false],
  ] as const)(
    'matches %s to the built-in official profile',
    (model, mode, efforts, supportsEffortParam, canDisableThinking) => {
      expect(matchKnownAnthropicModelProfile(model)).toEqual({
        mode,
        efforts,
        supportsEffortParam,
        canDisableThinking,
      });
    },
  );

  it('does not claim an official profile for an unrecognized compatible model', () => {
    expect(matchKnownAnthropicModelProfile('Example Compatible Model')).toBeUndefined();
  });
});

describe('resolveDefaultMaxTokens', () => {
  it('returns per-version Messages-API caps for known Claude 4 models', () => {
    expect(resolveDefaultMaxTokens('claude-fable-5')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-5-20251101')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-sonnet-5')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-5')).toBe(64000);
  });

  it('matches dotted version separators', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4.8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4.7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4.6')).toBe(128000);
  });

  it('falls back to the nearest lower catalogued minor for unknown minors', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4-9')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-10')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-9')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-9')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-opus-4-3')).toBe(32000);
  });

  it('honors a lower override and clamps an override above the ceiling', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 200)).toBe(200);
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 999999)).toBe(128000);
  });

  it('honors the override for unknown models and otherwise falls back to 128k', () => {
    expect(resolveDefaultMaxTokens('unknown-model', 12345)).toBe(12345);
    expect(resolveDefaultMaxTokens('totally-unknown-model')).toBe(128000);
  });
});

describe('AnthropicChatProvider constructor max_tokens', () => {
  it('uses per-version Messages-API caps for known Claude models', async () => {
    expect(await maxTokensFor('claude-opus-4-8')).toBe(128000);
    expect(await maxTokensFor('claude-opus-4-7')).toBe(128000);
    expect(await maxTokensFor('claude-sonnet-4-6')).toBe(128000);
  });

  it('honors defaultMaxTokens for unknown models', async () => {
    expect(await maxTokensFor('unknown-model', { defaultMaxTokens: 4321 })).toBe(4321);
  });

  it('uses the 128k fallback for unknown models without an override', async () => {
    expect(await maxTokensFor('unknown-model')).toBe(128000);
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

describe('AnthropicChatProvider thinking profiles', () => {
  it('uses the latest Opus profile for an unrecognized model name', async () => {
    const provider = new AnthropicChatProvider({
      model: 'compatible-model',
      apiKey: 'test-key',
      stream: false,
    }).withThinking('max');

    const body = await captureRequestBody(provider);

    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body['output_config']).toEqual({ effort: 'max' });
  });

  it('lets declared supportEfforts override a legacy model-name profile', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-5',
      apiKey: 'test-key',
      stream: false,
      supportEfforts: ['low', 'high', 'max'],
    }).withThinking('max');

    const body = await captureRequestBody(provider);

    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body['output_config']).toEqual({ effort: 'max' });
  });

  it('rejects an effort outside declared supportEfforts', () => {
    const provider = new AnthropicChatProvider({
      model: 'compatible-model',
      apiKey: 'test-key',
      supportEfforts: ['low', 'high'],
    });

    expect(() => provider.withThinking('max')).toThrow(
      'Unsupported thinking effort "max" for Anthropic model "compatible-model". Available: low, high.',
    );
  });

  it('rejects adaptive-only efforts when adaptiveThinking is false', () => {
    const provider = new AnthropicChatProvider({
      model: 'compatible-model',
      apiKey: 'test-key',
      adaptiveThinking: false,
      supportEfforts: ['low', 'high', 'max'],
    });

    expect(() => provider.withThinking('max')).toThrow(
      'declares efforts that budget-based thinking cannot express while adaptiveThinking is false',
    );
  });

  it('infers the budget profile for a pre-4.6 Claude model', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-5',
      apiKey: 'test-key',
      stream: false,
    }).withThinking('high');

    const body = await captureRequestBody(provider);

    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
    expect(body['output_config']).toEqual({ effort: 'high' });
  });

  it('does not convert max for a pre-4.6 Claude model', () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-5',
      apiKey: 'test-key',
    });

    expect(() => provider.withThinking('max')).toThrow(
      'Unsupported thinking effort "max" for Anthropic model "claude-opus-4-5". Available: low, medium, high.',
    );
  });

  it('rejects xhigh for 4.6 while preserving max', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-sonnet-4-6',
      apiKey: 'test-key',
      stream: false,
      adaptiveThinking: true,
    });

    expect(() => provider.withThinking('xhigh')).toThrow(
      'Available: low, medium, high, max',
    );
    const body = await captureRequestBody(provider.withThinking('max'));
    expect(body['output_config']).toEqual({ effort: 'max' });
  });

  it('rejects off for official always-on models', () => {
    for (const model of ['claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview']) {
      const provider = new AnthropicChatProvider({ model, apiKey: 'test-key' });
      expect(() => provider.withThinking('off')).toThrow(
        'has always-on thinking and cannot be disabled',
      );
    }
  });

  it('represents boolean on with the legacy high token budget', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-sonnet-4-5',
      apiKey: 'test-key',
      stream: false,
    }).withThinking('on');

    const body = await captureRequestBody(provider);

    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
    expect(body['output_config']).toBeUndefined();
  });
});
