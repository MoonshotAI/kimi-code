import type { Message } from '#/app/llmProtocol/message';
import { AnthropicChatProvider } from '#/app/llmProtocol/providers/anthropic';
import { describe, expect, it, vi } from 'vitest';

const HISTORY: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }];

function createProvider(): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model: 'kimi-for-coding',
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    stream: false,
  });
}

function makeAnthropicResponse() {
  return {
    id: 'msg_test_123',
    type: 'message',
    role: 'assistant',
    model: 'kimi-for-coding',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

async function captureBetaRequestBody(provider: AnthropicChatProvider): Promise<Record<string, unknown>> {
  let capturedParams: Record<string, unknown> | undefined;
  const standardCreate = vi.fn();

  (provider as unknown as { _client: { beta: { messages: { create: unknown } }; messages: { create: unknown } } })._client.beta.messages.create =
    vi.fn().mockImplementation((params: unknown) => {
      capturedParams = params as Record<string, unknown>;
      return Promise.resolve(makeAnthropicResponse());
    });
  (provider as unknown as { _client: { messages: { create: unknown } } })._client.messages.create = standardCreate;

  const stream = await provider.generate('', [], HISTORY);
  for await (const part of stream) void part;

  if (capturedParams === undefined) {
    throw new Error('Expected provider.generate() to call beta.messages.create');
  }
  expect(standardCreate).not.toHaveBeenCalled();
  return capturedParams;
}

describe('Anthropic withThinkingKeep context_management parity', () => {
  it('forces the beta endpoint and emits context_management clear_thinking keep', async () => {
    const body = await captureBetaRequestBody(createProvider().withThinkingKeep('all'));

    expect(body['context_management']).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(body['betas']).toContain('context-management-2025-06-27');
  });

  it('prepends clear_thinking before existing context-management edits', () => {
    const provider = createProvider()
      .withGenerationKwargs({
        contextManagement: {
          edits: [{ type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 2 } }],
        },
      })
      .withThinkingKeep('all');

    expect(Reflect.get(provider, '_generationKwargs')).toMatchObject({
      contextManagement: {
        edits: [
          { type: 'clear_thinking_20251015', keep: 'all' },
          { type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 2 } },
        ],
      },
    });
  });

  it('does not duplicate the context-management beta or clear_thinking edit', () => {
    const provider = createProvider().withThinkingKeep('all').withThinkingKeep('all');
    const generationKwargs = Reflect.get(provider, '_generationKwargs') as {
      readonly betaFeatures?: readonly string[];
      readonly contextManagement?: { readonly edits: readonly unknown[] };
    };

    expect(generationKwargs.betaFeatures?.filter((beta) => beta === 'context-management-2025-06-27')).toHaveLength(1);
    expect(generationKwargs.contextManagement?.edits).toEqual([
      { type: 'clear_thinking_20251015', keep: 'all' },
    ]);
  });
});
