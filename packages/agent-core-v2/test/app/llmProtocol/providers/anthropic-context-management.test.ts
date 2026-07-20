/**
 * Scenario: Anthropic context-management requests replay native and compatible-model history.
 * Responsibilities: emit preserved-thinking controls and normalize required compatible history only.
 * Wiring: real v2 Anthropic adapter with only the remote SDK client boundary replaced by mocks.
 * Run: pnpm exec vitest run packages/agent-core-v2/test/app/llmProtocol/providers/anthropic-context-management.test.ts
 */
import type { Message } from '#/app/llmProtocol/message';
import { AnthropicChatProvider } from '#/app/llmProtocol/providers/anthropic';
import { describe, expect, it, vi } from 'vitest';

const HISTORY: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }];

function createProvider(model = 'kimi-for-coding'): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model,
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

async function captureBetaRequestBody(
  provider: AnthropicChatProvider,
  history: Message[] = HISTORY,
): Promise<Record<string, unknown>> {
  let capturedParams: Record<string, unknown> | undefined;
  const standardCreate = vi.fn();

  (provider as unknown as { _client: { beta: { messages: { create: unknown } }; messages: { create: unknown } } })._client.beta.messages.create =
    vi.fn().mockImplementation((params: unknown) => {
      capturedParams = params as Record<string, unknown>;
      return Promise.resolve(makeAnthropicResponse());
    });
  (provider as unknown as { _client: { messages: { create: unknown } } })._client.messages.create = standardCreate;

  const stream = await provider.generate('', [], history);
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

  it('replays compatible text history without injecting thinking with keep all', async () => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        toolCalls: [],
      },
      { role: 'user', content: [{ type: 'text', text: 'Continue' }], toolCalls: [] },
    ];
    const provider = createProvider('compatible-preserved-thinking-model')
      .withThinking('max')
      .withThinkingKeep('all');

    const body = await captureBetaRequestBody(provider, history);
    const messages = body['messages'] as Array<{ role: string; content: unknown[] }>;

    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
    });
  });

  it('replays a compatible assistant tool call without injecting thinking with keep all', async () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_1', name: 'lookup', arguments: '{"q":"test"}' },
        ],
      },
    ];
    const provider = createProvider('compatible-preserved-thinking-model')
      .withThinking('max')
      .withThinkingKeep('all');

    const body = await captureBetaRequestBody(provider, history);
    const messages = body['messages'] as Array<{ role: string; content: unknown[] }>;

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'lookup',
          input: { q: 'test' },
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
  });

  it('preserves an existing empty thinking block when compatible history uses keep all', async () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: '' },
          { type: 'text', text: 'Hello' },
        ],
        toolCalls: [],
      },
    ];
    const provider = createProvider('compatible-preserved-thinking-model')
      .withThinking('max')
      .withThinkingKeep('all');

    const body = await captureBetaRequestBody(provider, history);
    const messages = body['messages'] as Array<{ role: string; content: unknown[] }>;

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
      ],
    });
  });

  it('leaves missing compatible thinking absent when keep all is not enabled', async () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        toolCalls: [],
      },
    ];
    const provider = createProvider('compatible-preserved-thinking-model').withThinking('max');

    let captured: Record<string, unknown> | undefined;
    (provider as unknown as { _client: { messages: { create: unknown } } })._client.messages.create =
      vi.fn().mockImplementation((params: unknown) => {
        captured = params as Record<string, unknown>;
        return Promise.resolve(makeAnthropicResponse());
      });

    const stream = await provider.generate('', [], history);
    for await (const part of stream) void part;
    const messages = captured?.['messages'] as Array<{ role: string; content: unknown[] }>;

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('leaves missing compatible thinking absent when thinking is disabled', async () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        toolCalls: [],
      },
    ];
    const provider = createProvider('compatible-preserved-thinking-model')
      .withThinking('off')
      .withThinkingKeep('all');

    const body = await captureBetaRequestBody(provider, history);
    const messages = body['messages'] as Array<{ role: string; content: unknown[] }>;

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }],
    });
  });

  it.each(['claude-opus-4-8', 'claude-opus-4-9', 'claude-mythos-preview'])(
    'does not synthesize unsigned thinking for Claude model %s with keep all',
    async (model) => {
      const history: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          toolCalls: [],
        },
      ];
      const provider = createProvider(model).withThinking('max').withThinkingKeep('all');

      const body = await captureBetaRequestBody(provider, history);
      const messages = body['messages'] as Array<{ role: string; content: unknown[] }>;

      expect(messages[0]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }],
      });
    },
  );
});
