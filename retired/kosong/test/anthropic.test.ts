/**
 * Scenario: Anthropic request serialization and response streaming across native and compatible models.
 * Responsibilities: preserve provider wire contracts, thinking semantics, tool calls, and request options.
 * Wiring: real Anthropic adapter with only the remote SDK client boundary replaced by mocks.
 * Run: pnpm exec vitest run packages/kosong/test/anthropic.test.ts
 */
import { ChatProviderError } from '#/errors';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/message';
import { AnthropicChatProvider, resolveDefaultMaxTokens } from '#/providers/anthropic';
import { matchKnownAnthropicModelProfile, matchUnknownClaudeProfile, LATEST_OPUS_PROFILE } from '#/providers/anthropic-profile';
import type { GenerateOptions } from '#/provider';
import type { Tool } from '#/tool';
import { describe, it, expect, vi } from 'vitest';

function makeAnthropicResponse(model: string = 'k25') {
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

function createProvider(
  model: string = 'k25',
  metadata?: Record<string, string>,
): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model,
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    metadata,
    stream: false,
  });
}

function createStreamProvider(model: string = 'k25'): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model,
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    stream: true,
  });
}

const UNSIGNED_THINKING_ONLY_HISTORY: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Start' }], toolCalls: [] },
  {
    role: 'assistant',
    content: [{ type: 'think', think: 'Partial reasoning' }],
    toolCalls: [],
  },
  { role: 'user', content: [{ type: 'text', text: 'Continue' }], toolCalls: [] },
];

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

  it.each([
    'claude-latest',
    'bedrock/claude-next',
    'sonnet-latest',
    'opus-latest',
    'gateway/haiku-proxy',
  ])('claims the unknown-Claude fallback for %s', (model) => {
    expect(matchUnknownClaudeProfile(model)).toEqual(LATEST_OPUS_PROFILE);
  });

  it.each(['k3', 'kimi-for-coding', 'glm-5.2', 'deepseek-v4-pro', 'Example Compatible Model'])(
    'does not claim the unknown-Claude fallback for %s',
    (model) => {
      expect(matchUnknownClaudeProfile(model)).toBeUndefined();
    },
  );
});

type AnthropicGenerationState = {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking?:
    | { type: 'disabled' }
    | { type: 'adaptive'; display?: string | undefined }
    | { type: 'enabled'; budget_tokens: number }
    | undefined;
  output_config?: { effort: string } | undefined;
  betaFeatures?: string[] | undefined;
  contextManagement?: { edits: Array<{ type: string; keep?: unknown }> } | undefined;
};

function getGenerationState(provider: AnthropicChatProvider): AnthropicGenerationState {
  return Reflect.get(provider, '_generationKwargs') as AnthropicGenerationState;
}

/** Capture the request body sent to Anthropic by mocking the client (non-stream mode). */
async function captureRequestBody(
  provider: AnthropicChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
  options?: GenerateOptions,
): Promise<Record<string, unknown>> {
  let capturedParams: Record<string, unknown> | undefined;
  let capturedOptions: Record<string, unknown> | undefined;

  (provider as any)._client.messages.create = vi
    .fn()
    .mockImplementation((params: unknown, options?: unknown) => {
      capturedParams = params as Record<string, unknown>;
      capturedOptions = options as Record<string, unknown> | undefined;
      return Promise.resolve(makeAnthropicResponse());
    });

  const stream = await provider.generate(systemPrompt, tools, history, options);
  for await (const part of stream) {
    void part;
  }

  if (capturedParams === undefined) {
    throw new Error('Expected provider.generate() to call messages.create');
  }

  const result = { ...capturedParams };
  if (capturedOptions !== undefined && capturedOptions['headers'] !== undefined) {
    result['_extra_headers'] = capturedOptions['headers'];
  }
  return result;
}

/** Create a mock stream that yields the given events as an async iterable. */
function mockStream(events: readonly unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

/** Collect all parts from a StreamedMessage. */
async function collectParts(
  streamedMessage: AsyncIterable<StreamedMessagePart>,
): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of streamedMessage) {
    parts.push(part);
  }
  return parts;
}

async function collectAnthropicStreamParts(
  events: readonly Record<string, unknown>[],
): Promise<StreamedMessagePart[]> {
  const create = vi.fn().mockResolvedValue(mockStream(events));
  const provider = new AnthropicChatProvider({
    model: 'kimi-for-coding',
    apiKey: '',
    stream: true,
    clientFactory: () => ({ messages: { create } }) as never,
  });

  return collectParts(
    await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] }],
    ),
  );
}

async function captureAnthropicMessages(
  model: string,
  history: Message[],
  configure?: (provider: AnthropicChatProvider) => AnthropicChatProvider,
): Promise<Array<{ role: string; content: unknown[] }>> {
  let captured: Record<string, unknown> | undefined;
  const create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve(makeAnthropicResponse(model));
  });
  let provider = new AnthropicChatProvider({
    model,
    apiKey: '',
    defaultMaxTokens: 1024,
    stream: false,
    clientFactory: () => ({ messages: { create }, beta: { messages: { create } } }) as never,
  });
  if (configure !== undefined) {
    provider = configure(provider);
  }

  const response = await provider.generate('', [], history);
  await collectParts(response);

  if (captured === undefined) {
    throw new Error('Expected Anthropic provider to send a request.');
  }
  return captured['messages'] as Array<{ role: string; content: unknown[] }>;
}

const ADD_TOOL: Tool = {
  name: 'add',
  description: 'Add two integers.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'integer', description: 'First number' },
      b: { type: 'integer', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
};

const MUL_TOOL: Tool = {
  name: 'multiply',
  description: 'Multiply two integers.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'integer', description: 'First number' },
      b: { type: 'integer', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
};

const B64_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA' +
  'DUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Capture the request body sent to the Anthropic beta Messages API by mocking
 * the client (non-stream mode). Also asserts the standard Messages API was
 * not called.
 */
async function captureBetaRequestBody(
  provider: AnthropicChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
): Promise<Record<string, unknown>> {
  let capturedParams: Record<string, unknown> | undefined;
  let capturedOptions: Record<string, unknown> | undefined;

  (provider as any)._client.beta.messages.create = vi
    .fn()
    .mockImplementation((params: unknown, options?: unknown) => {
      capturedParams = params as Record<string, unknown>;
      capturedOptions = options as Record<string, unknown> | undefined;
      return Promise.resolve(makeAnthropicResponse());
    });
  const standardCreate = vi.fn();
  (provider as any)._client.messages.create = standardCreate;

  const stream = await provider.generate(systemPrompt, tools, history);
  for await (const part of stream) {
    void part;
  }

  if (capturedParams === undefined) {
    throw new Error('Expected provider.generate() to call beta.messages.create');
  }
  expect(standardCreate).not.toHaveBeenCalled();

  const result = { ...capturedParams };
  if (capturedOptions !== undefined && capturedOptions['headers'] !== undefined) {
    result['_extra_headers'] = capturedOptions['headers'];
  }
  return result;
}

describe('betaApi', () => {
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
  ];

  it('routes to client.beta.messages.create with betas in the body and no beta header', async () => {
    const provider = new AnthropicChatProvider({
      model: 'kimi-for-coding',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: false,
      betaApi: true,
    });
    const body = await captureBetaRequestBody(provider, '', [], history);

    expect(body['betas']).toEqual(['interleaved-thinking-2025-05-14']);
    const headers = body['_extra_headers'] as Record<string, string> | undefined;
    expect(headers?.['anthropic-beta']).toBeUndefined();
  });

  it('keeps beta features in the anthropic-beta header when betaApi is off', async () => {
    const provider = new AnthropicChatProvider({
      model: 'kimi-for-coding',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: false,
    });
    const body = await captureRequestBody(provider, '', [], history);

    expect(body['betas']).toBeUndefined();
    const headers = body['_extra_headers'] as Record<string, string> | undefined;
    expect(headers?.['anthropic-beta']).toContain('interleaved-thinking-2025-05-14');
  });
});

describe('withThinkingKeep (context_management)', () => {
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
  ];

  it('forces the beta endpoint and emits context_management clear_thinking keep with the context-management beta', async () => {
    // betaApi is left at its default (false); withThinkingKeep must force it on.
    const provider = createProvider().withThinkingKeep('all');
    const body = await captureBetaRequestBody(provider, '', [], history);

    expect(body['context_management']).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(body['betas']).toContain('context-management-2025-06-27');
    expect(body['betas']).toContain('interleaved-thinking-2025-05-14');
    const headers = body['_extra_headers'] as Record<string, string> | undefined;
    expect(headers?.['anthropic-beta']).toBeUndefined();
  });

  it('prepends clear_thinking before existing context-management edits and keeps them', () => {
    const provider = createProvider()
      .withGenerationKwargs({
        contextManagement: {
          edits: [{ type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 2 } }],
        },
      })
      .withThinkingKeep('all');
    const state = getGenerationState(provider);
    expect(state.contextManagement).toEqual({
      edits: [
        { type: 'clear_thinking_20251015', keep: 'all' },
        { type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 2 } },
      ],
    });
  });

  it('emits no context_management and stays off the beta endpoint when withThinkingKeep is not applied', async () => {
    const body = await captureRequestBody(createProvider(), '', [], history);
    expect(body['context_management']).toBeUndefined();
    const headers = body['_extra_headers'] as Record<string, string> | undefined;
    expect(headers?.['anthropic-beta']).not.toContain('context-management-2025-06-27');
  });

  it('does not duplicate the context-management beta or the clear_thinking edit across repeated calls', () => {
    const provider = createProvider().withThinkingKeep('all').withThinkingKeep('all');
    const state = getGenerationState(provider);
    const betas = state.betaFeatures ?? [];
    expect(betas.filter((b) => b === 'context-management-2025-06-27')).toHaveLength(1);
    expect(state.contextManagement).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
  });

  // Capture a streaming (stream: true) beta-endpoint request by mocking
  // client.beta.messages.create to return a minimal valid stream.
  async function captureBetaStreamBody(
    provider: AnthropicChatProvider,
    history: Message[],
  ): Promise<Record<string, unknown>> {
    let capturedParams: Record<string, unknown> | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    (provider as any)._client.beta.messages.create = vi
      .fn()
      .mockImplementation((params: unknown, options?: unknown) => {
        capturedParams = params as Record<string, unknown>;
        capturedOptions = options as Record<string, unknown> | undefined;
        return Promise.resolve(
          mockStream([
            {
              type: 'message_start',
              message: { id: 'm', usage: { input_tokens: 1, output_tokens: 0 } },
            },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ]),
        );
      });
    const stream = await provider.generate('', [], history);
    for await (const part of stream) void part;
    if (capturedParams === undefined) {
      throw new Error('Expected provider.generate() to call beta.messages.create');
    }
    const result = { ...capturedParams };
    if (capturedOptions !== undefined && capturedOptions['headers'] !== undefined) {
      result['_extra_headers'] = capturedOptions['headers'];
    }
    return result;
  }

  it('emits context_management on the streaming beta endpoint too', async () => {
    const provider = createStreamProvider().withThinkingKeep('all');
    const body = await captureBetaStreamBody(provider, history);
    expect(body['context_management']).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(body['betas']).toContain('context-management-2025-06-27');
    const headers = body['_extra_headers'] as Record<string, string> | undefined;
    expect(headers?.['anthropic-beta']).toBeUndefined();
  });

  it('forces the beta endpoint even when constructed with betaApi: false', async () => {
    const provider = new AnthropicChatProvider({
      model: 'kimi-for-coding',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: false,
      betaApi: false,
    }).withThinkingKeep('all');
    const body = await captureBetaRequestBody(provider, '', [], history);
    expect(body['context_management']).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(body['betas']).toContain('context-management-2025-06-27');
  });

  it('replays compatible text history without injecting thinking when keep all is active', async () => {
    const compatibleHistory: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        toolCalls: [],
      },
      { role: 'user', content: [{ type: 'text', text: 'Continue' }], toolCalls: [] },
    ];
    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max').withThinkingKeep('all'),
    );

    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
    });
  });

  it('replays a compatible assistant tool call without injecting thinking when keep all is active', async () => {
    const compatibleHistory: Message[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_1', name: 'lookup', arguments: '{"q":"test"}' },
        ],
      },
    ];
    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max').withThinkingKeep('all'),
    );

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

  it('preserves an existing unsigned empty thinking block unchanged when keep all is active', async () => {
    const compatibleHistory: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: '' },
          { type: 'text', text: 'Hello' },
        ],
        toolCalls: [],
      },
    ];
    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max').withThinkingKeep('all'),
    );

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
      ],
    });
  });

  it('preserves all unsigned blocks unchanged when every one is empty', async () => {
    const compatibleHistory: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: '' },
          { type: 'think', think: '' },
          { type: 'text', text: 'Hello' },
        ],
        toolCalls: [],
      },
    ];

    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max').withThinkingKeep('all'),
    );

    expect(messages[0]!.content).toEqual([
      { type: 'thinking', thinking: '' },
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('replays each empty assistant message without injecting thinking when keep all is active', async () => {
    const compatibleHistory: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'First' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'First response' }],
        toolCalls: [],
      },
      { role: 'user', content: [{ type: 'text', text: 'Second' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Second response' }],
        toolCalls: [],
      },
      { role: 'user', content: [{ type: 'text', text: 'Third' }], toolCalls: [] },
    ];

    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max').withThinkingKeep('all'),
    );

    expect([messages[1]!.content[0], messages[3]!.content[0]]).toEqual([
      { type: 'text', text: 'First response' },
      { type: 'text', text: 'Second response' },
    ]);
  });

  it('preserves every unsigned block when one contains non-empty thinking', async () => {
    const compatibleHistory: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: '' },
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: 'Hello' },
        ],
        toolCalls: [],
      },
    ];

    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max').withThinkingKeep('all'),
    );

    expect(messages[0]!.content).toEqual([
      { type: 'thinking', thinking: '' },
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('preserves an empty signed thinking block when keep all is active', async () => {
    const compatibleHistory: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: '', encrypted: 'signature' },
          { type: 'text', text: 'Hello' },
        ],
        toolCalls: [],
      },
    ];

    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max').withThinkingKeep('all'),
    );

    expect(messages[0]!.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'signature' },
      { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('preserves the unsigned empty block when signed and unsigned thinking are empty', async () => {
    const compatibleHistory: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: '', encrypted: 'signature' },
          { type: 'think', think: '' },
          { type: 'text', text: 'Hello' },
        ],
        toolCalls: [],
      },
    ];

    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max').withThinkingKeep('all'),
    );

    expect(messages[0]!.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'signature' },
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('leaves unsigned empty thinking unchanged when signed thinking is non-empty', async () => {
    const compatibleHistory: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'signed reasoning', encrypted: 'signature' },
          { type: 'think', think: '' },
          { type: 'text', text: 'Hello' },
        ],
        toolCalls: [],
      },
    ];

    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max').withThinkingKeep('all'),
    );

    expect(messages[0]!.content).toEqual([
      { type: 'thinking', thinking: 'signed reasoning', signature: 'signature' },
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('leaves missing compatible thinking absent when keep all is not enabled', async () => {
    const compatibleHistory: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        toolCalls: [],
      },
    ];
    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('max'),
    );

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('leaves missing compatible thinking absent when thinking is disabled', async () => {
    const compatibleHistory: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        toolCalls: [],
      },
    ];
    const messages = await captureAnthropicMessages(
      'compatible-preserved-thinking-model',
      compatibleHistory,
      (provider) => provider.withThinking('off').withThinkingKeep('all'),
    );

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }],
    });
  });

  it.each(['claude-opus-4-8', 'claude-opus-4-9', 'claude-mythos-preview'])(
    'does not synthesize unsigned thinking for Claude model %s with keep all',
    async (model) => {
      const claudeHistory: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          toolCalls: [],
        },
      ];
      const messages = await captureAnthropicMessages(model, claudeHistory, (provider) =>
        provider.withThinking('max').withThinkingKeep('all'),
      );

      expect(messages[0]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }],
      });
    },
  );
});

describe('AnthropicChatProvider', () => {
  it('does not read ANTHROPIC_API_KEY from process.env inside the adapter', () => {
    const previousApiKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'env-key';

    try {
      const provider = new AnthropicChatProvider({
        model: 'k25',
        stream: false,
      });

      expect(Reflect.get(provider, '_apiKey')).toBeUndefined();
      expect(Reflect.get(provider, '_client')).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) {
        delete process.env['ANTHROPIC_API_KEY'];
      } else {
        process.env['ANTHROPIC_API_KEY'] = previousApiKey;
      }
    }
  });

  it('does not read ANTHROPIC_BASE_URL from process.env inside the adapter', () => {
    const previousBaseUrl = process.env['ANTHROPIC_BASE_URL'];
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:1';

    try {
      const provider = new AnthropicChatProvider({
        model: 'k25',
        apiKey: 'test-key',
        stream: false,
      });
      const client = Reflect.get(provider, '_client') as { baseURL?: string } | undefined;

      expect(client?.baseURL).toBe('https://api.anthropic.com');
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env['ANTHROPIC_BASE_URL'];
      } else {
        process.env['ANTHROPIC_BASE_URL'] = previousBaseUrl;
      }
    }
  });

  describe('message conversion', () => {
    it('simple user message with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are helpful.', [], history);

      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello!', cache_control: { type: 'ephemeral' } }],
        },
      ]);
      expect(body['system']).toEqual([
        { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('maps json_schema response format to output_config.format', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Extract contact' }], toolCalls: [] },
      ];
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      };

      const body = await captureRequestBody(provider, '', [], history, {
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'contact',
            schema,
            strict: true,
          },
        },
      });

      expect(body['output_config']).toEqual({
        format: {
          type: 'json_schema',
          schema,
        },
      });
    });

    it('rejects json_object response format because Anthropic requires a schema', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Extract contact' }], toolCalls: [] },
      ];

      await expect(
        provider.generate('', [], history, {
          responseFormat: { type: 'json_object' },
        }),
      ).rejects.toThrow('Anthropic provider requires a JSON schema for structured response output.');
    });

    it('multi-turn conversation', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: 'And 3+3?', cache_control: { type: 'ephemeral' } }],
        },
      ]);
      // No system when empty
      expect(body['system']).toBeUndefined();
    });

    it('multi-turn with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are a math tutor.', [], history);

      expect(body['system']).toEqual([
        { type: 'text', text: 'You are a math tutor.', cache_control: { type: 'ephemeral' } },
      ]);
      expect(body['messages']).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: 'And 3+3?', cache_control: { type: 'ephemeral' } }],
        },
      ]);
    });

    it('image url content (url source)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this image?" },
            { type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } },
          ] satisfies ContentPart[],
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this image?" },
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.com/image.png' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('video url content (base64 data URL)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this video?" },
            { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } },
          ] satisfies ContentPart[],
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this video?" },
            {
              type: 'video',
              source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' },
            },
          ],
        },
      ]);
    });

    it('video url content passes a non-data URL through as a url source', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'video_url', videoUrl: { url: 'ms://file-abc' } },
            { type: 'video_url', videoUrl: { url: 'https://example.com/video.mp4' } },
          ] satisfies ContentPart[],
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      // Non-data video references (moonshot `ms://` file ids carried over from a
      // kimi turn, or http URLs) are emitted as url-source video blocks — the
      // kimi anthropic endpoint resolves them server-side, exactly like image
      // url sources.
      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'video', source: { type: 'url', url: 'ms://file-abc' } },
            { type: 'video', source: { type: 'url', url: 'https://example.com/video.mp4' } },
          ],
        },
      ]);
    });

    it('video url content rejects unsupported media type', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'video_url', videoUrl: { url: 'data:image/png;base64,AAAA' } },
          ] satisfies ContentPart[],
          toolCalls: [],
        },
      ];
      await expect(captureRequestBody(provider, '', [], history)).rejects.toThrow(ChatProviderError);
    });

    it('tool result with video content', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Run tool' }],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [],
          toolCalls: [{ type: 'function', id: 'call_1', name: 'add', arguments: '{"a":1,"b":2}' }],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'see video' },
            { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } },
          ] satisfies ContentPart[],
          toolCalls: [],
          toolCallId: 'call_1',
        },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL], history);

      const messages = body['messages'] as Array<{ role: string; content: unknown[] }>;
      const lastContent = messages.at(-1)!.content as Array<{ type: string; content: unknown[] }>;
      const toolResult = lastContent[0]!;
      expect(toolResult.type).toBe('tool_result');
      expect(toolResult.content).toEqual([
        { type: 'text', text: 'see video' },
        { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' } },
      ]);
    });

    it('tool definitions with cache_control on last tool', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      expect(body['tools']).toEqual([
        {
          name: 'add',
          description: 'Add two integers.',
          input_schema: {
            type: 'object',
            properties: {
              a: { type: 'integer', description: 'First number' },
              b: { type: 'integer', description: 'Second number' },
            },
            required: ['a', 'b'],
          },
        },
        {
          name: 'multiply',
          description: 'Multiply two integers.',
          input_schema: {
            type: 'object',
            properties: {
              a: { type: 'integer', description: 'First number' },
              b: { type: 'integer', description: 'Second number' },
            },
            required: ['a', 'b'],
          },
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('tool call and tool result (Anthropic wire format)', async () => {
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_abc123',
        name: 'add', arguments: '{"a": 2, "b": 3}',
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll add those numbers for you." }],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '5' }],
          toolCallId: 'call_abc123',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      // Snapshot of the expected wire format:
      // user message has NO cache_control, assistant has tool_use blocks,
      // final user message's tool_result carries cache_control (last block).
      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Add 2 and 3' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll add those numbers for you." },
            { type: 'tool_use', id: 'call_abc123', name: 'add', input: { a: 2, b: 3 } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_abc123',
              content: [{ type: 'text', text: '5' }],
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('normalizes invalid historical tool call ids and matching tool results', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Run tools' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'Write:6',
              name: 'Write',
              arguments: '{"path":"/tmp/b","content":"ok"}',
            },
            {
              type: 'function',
              id: 'Write_6',
              name: 'Write',
              arguments: '{"path":"/tmp/a","content":"ok"}',
            },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'wrote b' }],
          toolCallId: 'Write:6',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'wrote a' }],
          toolCallId: 'Write_6',
          toolCalls: [],
        },
      ];

      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Run tools' }],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Write_6_2',
              name: 'Write',
              input: { path: '/tmp/b', content: 'ok' },
            },
            {
              type: 'tool_use',
              id: 'Write_6',
              name: 'Write',
              input: { path: '/tmp/a', content: 'ok' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'Write_6_2',
              content: [{ type: 'text', text: 'wrote b' }],
            },
            {
              type: 'tool_result',
              tool_use_id: 'Write_6',
              content: [{ type: 'text', text: 'wrote a' }],
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('tool call with image result wraps image source inside tool_result', async () => {
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_abc123',
        name: 'add', arguments: '{"a": 2, "b": 3}',
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll add those numbers for you." }],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: '5' },
            { type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } },
          ] satisfies ContentPart[],
          toolCallId: 'call_abc123',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as unknown[];

      // Tool result block carries both text and image.
      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_abc123',
            content: [
              { type: 'text', text: '5' },
              {
                type: 'image',
                source: { type: 'url', url: 'https://example.com/image.png' },
              },
            ],
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('user audio parts degrade to placeholder text, video parts convert to video blocks', async () => {
      // Audio still has no Messages-API representation and degrades to a
      // placeholder text block (consecutive same-kind placeholders collapse).
      // Video is now carried as a base64 `video` content block.
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Listen and watch:' },
            { type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3' } },
            { type: 'audio_url', audioUrl: { url: 'https://example.com/b.mp3' } },
            { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } },
          ] satisfies ContentPart[],
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as Record<string, unknown>[];

      expect(messages[0]?.['content']).toEqual([
        { type: 'text', text: 'Listen and watch:' },
        { type: 'text', text: '(audio omitted: not supported by this provider)' },
        {
          type: 'video',
          source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' },
        },
      ]);
    });

    it('tool result audio degrades to placeholder text inside tool_result', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Say hi' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [],
          toolCalls: [{ type: 'function', id: 'call_tts', name: 'tts', arguments: '{}' }],
        },
        {
          role: 'tool',
          content: [
            { type: 'audio_url', audioUrl: { url: 'https://example.com/hi.mp3' } },
          ] satisfies ContentPart[],
          toolCallId: 'call_tts',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as Record<string, unknown>[];

      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_tts',
            content: [
              { type: 'text', text: '(audio omitted: not supported by this provider)' },
            ],
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('parallel tool calls and tool results (request body capture)', async () => {
      const provider = createProvider();
      const tcAdd: ToolCall = {
        type: 'function',
        id: 'call_add',
        name: 'add', arguments: '{"a": 2, "b": 3}',
      };
      const tcMul: ToolCall = {
        type: 'function',
        id: 'call_mul',
        name: 'multiply', arguments: '{"a": 4, "b": 5}',
      };
      const history: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Calculate 2+3 and 4*5' }],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll calculate both." }],
          toolCalls: [tcAdd, tcMul],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'text',
              text: '<system-reminder>This is a system reminder</system-reminder>',
            },
            { type: 'text', text: '5' },
          ],
          toolCallId: 'call_add',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'text',
              text: '<system-reminder>This is a system reminder</system-reminder>',
            },
            { type: 'text', text: '20' },
          ],
          toolCallId: 'call_mul',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      // Per the Anthropic Messages API parallel-tool-use spec, all tool_result
      // blocks answering parallel tool_use calls MUST live in a single user
      // message — not split across consecutive user messages. Splitting hard-
      // fails strict Anthropic-compatible backends (HTTP 400) and silently
      // degrades parallel tool use on api.anthropic.com. This asserts:
      //  - exactly 3 messages in the expected order
      //  - both tool_result blocks are bundled in the trailing user message
      //  - cache_control lands on the LAST block after merging (call_mul's
      //    tool_result), mirroring the "cache the longest prefix" policy.
      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Calculate 2+3 and 4*5' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll calculate both." },
            { type: 'tool_use', id: 'call_add', name: 'add', input: { a: 2, b: 3 } },
            { type: 'tool_use', id: 'call_mul', name: 'multiply', input: { a: 4, b: 5 } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_add',
              content: [
                {
                  type: 'text',
                  text: '<system-reminder>This is a system reminder</system-reminder>',
                },
                { type: 'text', text: '5' },
              ],
            },
            {
              type: 'tool_result',
              tool_use_id: 'call_mul',
              content: [
                {
                  type: 'text',
                  text: '<system-reminder>This is a system reminder</system-reminder>',
                },
                { type: 'text', text: '20' },
              ],
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    // Independent assertion-style regression test for the Anthropic
    // parallel-tool-use spec. Documents the spec-required shape without
    // relying on snapshot equality — so if anyone regenerates the
    // snapshot above against buggy (split) output again, this test still
    // fails.
    it('parallel tool_results merged into single trailing user message', async () => {
      const provider = createProvider();
      const tcAdd: ToolCall = {
        type: 'function',
        id: 'call_add',
        name: 'add', arguments: '{"a": 2, "b": 3}',
      };
      const tcMul: ToolCall = {
        type: 'function',
        id: 'call_mul',
        name: 'multiply', arguments: '{"a": 4, "b": 5}',
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Calculate 2+3 and 4*5' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll calculate both." }],
          toolCalls: [tcAdd, tcMul],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '5' }],
          toolCallId: 'call_add',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '20' }],
          toolCallId: 'call_mul',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      type MsgParam = { role: string; content: Array<{ type: string; tool_use_id?: string }> };
      const msgs = body['messages'] as MsgParam[];

      // 3 messages: initial user prompt, assistant with parallel tool_use,
      // and a single trailing user message carrying BOTH tool_result blocks.
      expect(msgs).toHaveLength(3);
      expect(msgs[0]!.role).toBe('user');
      expect(msgs[1]!.role).toBe('assistant');
      expect(msgs[2]!.role).toBe('user');

      const trailing = msgs[2]!.content;
      expect(trailing).toHaveLength(2);
      expect(trailing[0]!.type).toBe('tool_result');
      expect(trailing[0]!.tool_use_id).toBe('call_add');
      expect(trailing[1]!.type).toBe('tool_result');
      expect(trailing[1]!.tool_use_id).toBe('call_mul');
    });

    // Edge case: single (non-parallel) tool call should NOT trigger merge
    // semantics — the one tool_result sits alone in its own user message,
    // same as before. Guards against an over-eager merge that concatenates
    // across turns.
    it('single tool call: no merge triggered', async () => {
      const provider = createProvider();
      const tcAdd: ToolCall = {
        type: 'function',
        id: 'call_add',
        name: 'add', arguments: '{"a": 2, "b": 3}',
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+3?' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Calculating.' }],
          toolCalls: [tcAdd],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '5' }],
          toolCallId: 'call_add',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL], history);

      type MsgParam = { role: string; content: Array<{ type: string; tool_use_id?: string }> };
      const msgs = body['messages'] as MsgParam[];

      expect(msgs).toHaveLength(3);
      expect(msgs[2]!.content).toHaveLength(1);
      expect(msgs[2]!.content[0]!.type).toBe('tool_result');
      expect(msgs[2]!.content[0]!.tool_use_id).toBe('call_add');
    });

    // Edge case: 3 parallel tool calls collapse into one user message with
    // 3 tool_result blocks (order preserved).
    it('three parallel tool_results merged in order', async () => {
      const provider = createProvider();
      const makeTc = (id: string, name: string): ToolCall => ({
        type: 'function',
        id,
        name, arguments: '{"a": 1, "b": 1}',
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Do three things' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Running.' }],
          toolCalls: [makeTc('c1', 'add'), makeTc('c2', 'multiply'), makeTc('c3', 'add')],
        },
        { role: 'tool', content: [{ type: 'text', text: '2' }], toolCallId: 'c1', toolCalls: [] },
        { role: 'tool', content: [{ type: 'text', text: '1' }], toolCallId: 'c2', toolCalls: [] },
        { role: 'tool', content: [{ type: 'text', text: '2' }], toolCallId: 'c3', toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      type MsgParam = { role: string; content: Array<{ type: string; tool_use_id?: string }> };
      const msgs = body['messages'] as MsgParam[];

      expect(msgs).toHaveLength(3);
      const trailing = msgs[2]!.content;
      expect(trailing).toHaveLength(3);
      expect(trailing.map((b) => b.tool_use_id)).toEqual(['c1', 'c2', 'c3']);
      expect(trailing.every((b) => b.type === 'tool_result')).toBe(true);
    });

    // Edge case: parallel tool results followed by a plain user text turn.
    // The tool_result-only user messages merge with each other AND absorb the
    // following text turn, producing a single `[tool_result, tool_result, text]`
    // user message. Strict Anthropic-compatible backends reject consecutive
    // user messages, so the follow-up text must not be left in its own turn.
    it('merges a follow-up text turn into the preceding tool_results', async () => {
      const provider = createProvider();
      const tcAdd: ToolCall = {
        type: 'function',
        id: 'call_add',
        name: 'add', arguments: '{"a": 2, "b": 3}',
      };
      const tcMul: ToolCall = {
        type: 'function',
        id: 'call_mul',
        name: 'multiply', arguments: '{"a": 4, "b": 5}',
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Do both' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Running.' }],
          toolCalls: [tcAdd, tcMul],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '5' }],
          toolCallId: 'call_add',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '20' }],
          toolCallId: 'call_mul',
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Now summarize' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      type MsgParam = {
        role: string;
        content: Array<{ type: string; tool_use_id?: string; text?: string }>;
      };
      const msgs = body['messages'] as MsgParam[];

      // 3 messages: user prompt, assistant tool_use, and a single merged user
      // turn holding both tool_results followed by the follow-up text.
      expect(msgs).toHaveLength(3);
      expect(msgs[2]!.role).toBe('user');
      expect(msgs[2]!.content).toHaveLength(3);
      expect(msgs[2]!.content.slice(0, 2).every((b) => b.type === 'tool_result')).toBe(true);
      expect(msgs[2]!.content[2]!.type).toBe('text');
      expect(msgs[2]!.content[2]!.text).toBe('Now summarize');
    });

    // Single tool call answered, then a follow-up text turn (e.g. an injected
    // reminder/notification after the tool result). The tool_result and the
    // text must collapse into one user message so no two user turns are adjacent.
    it('merges a single tool_result with a following injected text turn', async () => {
      const provider = createProvider();
      const tcRead: ToolCall = {
        type: 'function',
        id: 'call_read',
        name: 'read',
        arguments: '{"path": "a.ts"}',
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Read it' }], toolCalls: [] },
        { role: 'assistant', content: [], toolCalls: [tcRead] },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'file body' }],
          toolCallId: 'call_read',
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'system reminder' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      const msgs = body['messages'] as Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
      }>;

      // No two adjacent user messages: tool_result + reminder share one turn.
      const roles = msgs.map((m) => m.role);
      expect(roles).toEqual(['user', 'assistant', 'user']);
      expect(msgs[2]!.content).toHaveLength(2);
      expect(msgs[2]!.content[0]!.type).toBe('tool_result');
      expect(msgs[2]!.content[1]!.type).toBe('text');
      expect(msgs[2]!.content[1]!.text).toBe('system reminder');
    });

    it('merges consecutive plain-text user messages into one', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'First' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'Second' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'Third' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      const msgs = body['messages'] as Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
      }>;

      // Strict Anthropic-compatible backends reject consecutive user messages,
      // so back-to-back plain-text user turns (e.g. the post-compaction shape
      // of kept prompts + user-role summary + reminders) must be collapsed.
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.role).toBe('user');
      expect(msgs[0]!.content.map((block) => block.text)).toEqual(['First', 'Second', 'Third']);
    });

    it('assistant with thinking (has encrypted -> ThinkingBlockParam)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Let me think...', encrypted: 'sig_abc123' },
            { type: 'text', text: 'The answer is 4.' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Thanks!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      // Snapshot of the expected wire format:
      // first user message has NO cache_control, assistant has thinking + text,
      // LAST user message's text block carries cache_control.
      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'What is 2+2?' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think...', signature: 'sig_abc123' },
            { type: 'text', text: 'The answer is 4.' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Thanks!', cache_control: { type: 'ephemeral' } }],
        },
      ]);
    });

    it('thinking without signature is preserved (no signature field)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Thinking...' },
            { type: 'text', text: 'Hello!' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Bye' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as unknown[];

      // Unsigned thinking must still be PRESERVED for non-Claude models,
      // emitted without a `signature` field. Anthropic-compatible backends
      // (e.g. Kimi) reject a tool-call turn whose thinking is missing
      // ("reasoning_content is missing").
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Thinking...' },
          { type: 'text', text: 'Hello!' },
        ],
      });
    });

    it('preserves unsigned empty thinking for Anthropic-compatible models', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'think', think: '' }],
          toolCalls: [
            { type: 'function', id: 'toolu_1', name: 'lookup', arguments: '{"q":"test"}' },
          ],
        },
      ];

      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as Array<{ role: string; content: unknown[] }>;

      expect(messages[0]!.content[0]).toEqual({ type: 'thinking', thinking: '' });
    });

    it('preserves an unsigned-only assistant message for Anthropic-compatible models', async () => {
      const messages = await captureAnthropicMessages(
        'compatible-model',
        UNSIGNED_THINKING_ONLY_HISTORY,
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Partial reasoning' }],
      });
    });

    it.each([
      'claude-opus-4-6',
      'opus-4-6',
      'claude-opus-4-9',
      'opus-4-9',
      'claude-mythos-preview',
    ])(
      'drops unsigned thinking for Claude model %s before tool_use blocks',
      async (model) => {
        const provider = createProvider(model);
        const history: Message[] = [
          { role: 'user', content: [{ type: 'text', text: 'Search for 429' }], toolCalls: [] },
          {
            role: 'assistant',
            content: [{ type: 'think', think: 'Let me grep for 429.' }],
            toolCalls: [
              { type: 'function', id: 'toolu_1', name: 'Grep', arguments: '{"pattern":"429"}' },
            ],
          },
          {
            role: 'tool',
            content: [{ type: 'text', text: 'found in chat.go' }],
            toolCallId: 'toolu_1',
            toolCalls: [],
          },
        ];
        const body = await captureRequestBody(provider, '', [], history);
        const messages = body['messages'] as Array<{ role: string; content: unknown[] }>;

        expect(messages[1]!.role).toBe('assistant');
        expect(messages[1]!.content).toEqual([
          { type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: '429' } },
        ]);
      },
    );

    it('drops an unsigned-only Claude assistant without leaving an empty wire message', async () => {
      const messages = await captureAnthropicMessages(
        'claude-opus-4-9',
        UNSIGNED_THINKING_ONLY_HISTORY,
      );

      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Start' },
            { type: 'text', text: 'Continue', cache_control: { type: 'ephemeral' } },
          ],
        },
      ]);
    });

    it('base64 image', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe:' },
            {
              type: 'image_url',
              imageUrl: { url: `data:image/png;base64,${B64_PNG}` },
            },
          ] satisfies ContentPart[],
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe:' },
            {
              type: 'image',
              source: { type: 'base64', data: B64_PNG, media_type: 'image/png' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('redacted thinking (empty think with encrypted)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: '', encrypted: 'enc_redacted_sig_xyz' },
            { type: 'text', text: '4.' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Thanks!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as unknown[];

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'enc_redacted_sig_xyz' },
          { type: 'text', text: '4.' },
        ],
      });
    });

    it('unsigned thinking is preserved before a tool_use block', async () => {
      // Reproduces the real failure: a streamed assistant turn whose thinking
      // arrived without a signature_delta, followed by a tool_use. Dropping the
      // thinking made Kimi reject the *next* request with
      // "thinking is enabled but reasoning_content is missing".
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Search for 429' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'think', think: 'Let me grep for 429.' }],
          toolCalls: [
            { type: 'function', id: 'toolu_1', name: 'Grep', arguments: '{"pattern":"429"}' },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'found in chat.go' }],
          toolCallId: 'toolu_1',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as Array<{ role: string; content: unknown[] }>;

      expect(messages[1]!.role).toBe('assistant');
      expect(messages[1]!.content).toEqual([
        { type: 'thinking', thinking: 'Let me grep for 429.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: '429' } },
      ]);
    });
  });

  describe('generation kwargs', () => {
    it('applies temperature, top_p, and max_tokens', async () => {
      const provider = createProvider().withGenerationKwargs({
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 2048,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['temperature']).toBe(0.7);
      expect(body['top_p']).toBe(0.9);
      expect(body['max_tokens']).toBe(2048);
    });

    it('combines thinking and max_tokens in internal state', () => {
      const provider = createProvider('claude-sonnet-4-5')
        .withThinking('high')
        .withGenerationKwargs({ max_tokens: 512 });
      const state = getGenerationState(provider);

      expect(state).toMatchObject({
        max_tokens: 512,
        thinking: { type: 'enabled', budget_tokens: 32_000 },
      });
    });

    it('keeps the same internal state regardless of withThinking/withGenerationKwargs order', () => {
      const thinkingThenKwargs = getGenerationState(
        createProvider().withThinking('high').withGenerationKwargs({ max_tokens: 512 }),
      );
      const kwargsThenThinking = getGenerationState(
        createProvider().withGenerationKwargs({ max_tokens: 512 }).withThinking('high'),
      );

      expect(kwargsThenThinking).toEqual(thinkingThenKwargs);
    });

    it('shallow-merges repeated withGenerationKwargs calls and replaces duplicate keys', () => {
      const provider = createProvider()
        .withGenerationKwargs({ max_tokens: 256, temperature: 0.1 })
        .withGenerationKwargs({ max_tokens: 512 });

      expect(getGenerationState(provider)).toMatchObject({
        max_tokens: 512,
        temperature: 0.1,
      });
    });
  });

  describe('with thinking', () => {
    const thinkHistory: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
    ];

    it('pre-4.6 model: high -> budget_tokens=32000', async () => {
      const provider = createProvider('claude-sonnet-4-5').withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
      expect(body['output_config']).toBeUndefined();
    });

    it('opus-4-6: uses adaptive thinking', async () => {
      const provider = createProvider('opus-4-6').withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'high' });
      // Adaptive should remove interleaved-thinking beta
      const headers = body['_extra_headers'] as Record<string, string> | undefined;
      if (headers !== undefined && headers['anthropic-beta'] !== undefined) {
        expect(headers['anthropic-beta']).not.toContain('interleaved-thinking-2025-05-14');
      }
    });

    it('opus-4-7: uses adaptive thinking with xhigh effort', async () => {
      const provider = createProvider('claude-opus-4-7').withThinking('xhigh');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'xhigh' });
    });

    it('claude-fable-5: uses adaptive thinking with xhigh effort', async () => {
      const provider = createProvider('claude-fable-5').withThinking('xhigh');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'xhigh' });
      // Adaptive should remove interleaved-thinking beta
      const headers = body['_extra_headers'] as Record<string, string> | undefined;
      if (headers !== undefined && headers['anthropic-beta'] !== undefined) {
        expect(headers['anthropic-beta']).not.toContain('interleaved-thinking-2025-05-14');
      }
    });

    it.each(['claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview'])(
      '%s: passes thinking off through for the backend to validate',
      async (model) => {
        const body = await captureRequestBody(
          createProvider(model).withThinking('off'),
          '',
          [],
          thinkHistory,
        );

        expect(body['thinking']).toEqual({ type: 'disabled' });
        expect(body['output_config']).toBeUndefined();
      },
    );

    it.each([
      'claude-sonnet-4-6',
      'anthropic.claude-opus-4-7-v1:0',
      'publishers/anthropic/models/claude-sonnet-4-6',
    ])('%s: uses adaptive thinking', async (model) => {
      const provider = createProvider(model).withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'high' });
    });

    it('future 4.6+ model uses adaptive thinking and passes xhigh through', async () => {
      const provider = createProvider('claude-sonnet-4-8').withThinking('xhigh');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'xhigh' });
    });

    it('opus-4-6 supports max effort', async () => {
      const provider = createProvider('claude-opus-4-6').withThinking('max');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'max' });
    });

    it('adaptiveThinking=true forces adaptive on an unversioned model name', async () => {
      const provider = new AnthropicChatProvider({
        model: 'compatible-model',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        adaptiveThinking: true,
      }).withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'high' });
    });

    it('forced adaptive passes max effort through', async () => {
      const provider = new AnthropicChatProvider({
        model: 'coding-model-okapi-0527-vibe',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        adaptiveThinking: true,
      }).withThinking('max');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'max' });
    });

    it('adaptiveThinking=true passes an unlisted effort through unchanged', async () => {
      const provider = new AnthropicChatProvider({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        stream: false,
        adaptiveThinking: true,
      }).withThinking('xhigh');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'xhigh' });
    });

    it('unversioned model without supportEfforts preserves max through the latest Opus profile', async () => {
      const provider = new AnthropicChatProvider({
        model: 'coding-model-okapi-0527-vibe',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
      }).withThinking('max');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'max' });
    });

    it('declared supportEfforts override a legacy model-name profile', async () => {
      const provider = new AnthropicChatProvider({
        model: 'claude-opus-4-5',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        supportEfforts: ['low', 'medium', 'high', 'max'],
      }).withThinking('max');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'max' });
    });

    it('passes efforts outside declared supportEfforts without converting them', async () => {
      const provider = new AnthropicChatProvider({
        model: 'Example Compatible Model',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        supportEfforts: ['low', 'high'],
      }).withThinking('max');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'max' });
    });

    it('keeps a concrete effort when adaptiveThinking is false', async () => {
      const provider = new AnthropicChatProvider({
        model: 'Example Compatible Model',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        adaptiveThinking: false,
        supportEfforts: ['low', 'high', 'max'],
      }).withThinking('max');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'enabled' });
      expect(body['output_config']).toEqual({ effort: 'max' });
    });

    it('Kimi thinking mode sends concrete effort without budget conversion', async () => {
      const provider = new AnthropicChatProvider({
        model: 'kimi-for-coding',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        kimiThinking: true,
      }).withThinking('max');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'enabled' });
      expect(body['output_config']).toEqual({ effort: 'max' });
    });

    it('Kimi thinking mode passes concrete efforts through and omits only on', async () => {
      const provider = new AnthropicChatProvider({
        model: 'kimi-for-coding',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        kimiThinking: true,
      });
      for (const requested of ['xhigh', 'medium', 'on'] as const) {
        const body = await captureRequestBody(provider.withThinking(requested), '', [], thinkHistory);
        expect(body['thinking']).toEqual({ type: 'enabled' });
        expect(body['output_config']).toEqual(
          requested === 'on' ? undefined : { effort: requested },
        );
      }
    });

    it('Kimi thinking mode keeps thinking off clean', async () => {
      const provider = new AnthropicChatProvider({
        model: 'kimi-for-coding',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        kimiThinking: true,
      }).withThinking('off');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'disabled' });
      expect(body['output_config']).toBeUndefined();
    });

    it('thinkingEffort reads back Kimi concrete efforts and boolean on', () => {
      const provider = new AnthropicChatProvider({
        model: 'kimi-for-coding',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        kimiThinking: true,
      });
      expect(provider.withThinking('max').thinkingEffort).toBe('max');
      expect(provider.withThinking('xhigh').thinkingEffort).toBe('xhigh');
      expect(provider.withThinking('off').thinkingEffort).toBe('off');
    });

    it('adaptiveThinking=false forces budget on a 4.6 model name', async () => {
      const provider = new AnthropicChatProvider({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        adaptiveThinking: false,
      }).withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
      expect(body['output_config']).toBeUndefined();
    });

    it('adaptiveThinking=false omits the effort param for an unversioned model name', async () => {
      const provider = new AnthropicChatProvider({
        model: 'coding-model-okapi-0527-vibe',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
        stream: false,
        adaptiveThinking: false,
      });
      for (const [effort, budget] of [
        ['low', 1024],
        ['medium', 4096],
        ['high', 32_000],
      ] as const) {
        const body = await captureRequestBody(provider.withThinking(effort), '', [], thinkHistory);
        expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: budget });
        expect(body['output_config']).toBeUndefined();
      }
    });

    it('pre-4.6 budget model passes xhigh and max through unchanged', async () => {
      for (const effort of ['xhigh', 'max'] as const) {
        const body = await captureRequestBody(
          createProvider('claude-sonnet-4-5').withThinking(effort),
          '',
          [],
          thinkHistory,
        );
        expect(body['thinking']).toEqual({ type: 'enabled' });
        expect(body['output_config']).toEqual({ effort });
      }
    });

    it('opus-4-5 passes xhigh through unchanged', async () => {
      const body = await captureRequestBody(
        createProvider('claude-opus-4-5').withThinking('xhigh'),
        '',
        [],
        thinkHistory,
      );

      expect(body['thinking']).toEqual({ type: 'enabled' });
      expect(body['output_config']).toEqual({ effort: 'xhigh' });
    });

    it('opus-4-6 with thinking off -> disabled', async () => {
      const provider = createProvider('opus-4-6').withThinking('off');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'disabled' });
      expect(body['output_config']).toBeUndefined();
      const headers = body['_extra_headers'] as Record<string, string> | undefined;
      expect(headers?.['anthropic-beta']).toBeUndefined();
    });

    it('adaptive thinking off clears stale output_config', async () => {
      const provider = createProvider('opus-4-6').withThinking('high').withThinking('off');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'disabled' });
      expect(body['output_config']).toBeUndefined();
    });

    it('replaces the previous thinking config when called again', () => {
      const provider = createProvider().withThinking('high').withThinking('off');

      expect(getGenerationState(provider).thinking).toEqual({ type: 'disabled' });
    });

    it('claude-3-5-sonnet legacy: high sends budget thinking without output_config', async () => {
      const provider = createProvider('claude-3-5-sonnet-20240620').withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
      expect(body['output_config']).toBeUndefined();
    });

    it('haiku-4-5 legacy: medium sends budget thinking without output_config', async () => {
      const provider = createProvider('claude-haiku-4-5-20251001').withThinking('medium');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 4096 });
      expect(body['output_config']).toBeUndefined();
    });

    it('opus-4-7: low effort passes through to output_config', async () => {
      const provider = createProvider('claude-opus-4-7').withThinking('low');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['output_config']).toEqual({ effort: 'low' });
    });

    it('opus-4-7: medium effort passes through to output_config', async () => {
      const provider = createProvider('claude-opus-4-7').withThinking('medium');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['output_config']).toEqual({ effort: 'medium' });
    });

    it('future opus-4-8 uses adaptive thinking via regex extrapolation', async () => {
      const provider = createProvider('claude-opus-4-8').withThinking('xhigh');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'xhigh' });
    });

    it('opus-4-7 + high stays high', async () => {
      const provider = createProvider('claude-opus-4-7').withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'high' });
    });

    it.each([
      ['low', 1024],
      ['medium', 4096],
      ['high', 32000],
    ] as const)(
      'sonnet-4 (pre-4.6) %s: budget_tokens=%i, no output_config',
      async (effort, budget) => {
        const provider = createProvider('claude-sonnet-4-20250514').withThinking(effort);
        const body = await captureRequestBody(provider, '', [], thinkHistory);

        expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: budget });
        expect(body['output_config']).toBeUndefined();
      },
    );

    it.each([
      // opus-4-7 passes all efforts through unchanged
      ['claude-opus-4-7', 'low', 'low'],
      ['claude-opus-4-7', 'medium', 'medium'],
      ['claude-opus-4-7', 'high', 'high'],
      ['claude-opus-4-7', 'xhigh', 'xhigh'],
      ['claude-opus-4-7', 'max', 'max'],
      ['claude-opus-4-6', 'max', 'max'],
    ] as const)(
      'adaptive wire body: %s + %s -> output_config.effort=%s',
      async (model, effort, expected) => {
        const provider = createProvider(model).withThinking(effort);
        const body = await captureRequestBody(provider, '', [], thinkHistory);

        expect(body['output_config']).toEqual({ effort: expected });
      },
    );

    it('legacy wire body: sonnet-4-5 (non-adaptive) has no output_config', async () => {
      const provider = createProvider('claude-sonnet-4-5').withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['output_config']).toBeUndefined();
    });

    it.each([
      'claude-opus-4-7',
      'claude-opus-4-8',
      'anthropic.claude-opus-4-7-v1:0',
      'vertex_ai/claude-opus-4-7',
      'bedrock/anthropic.claude-opus-4-6-v1:0',
    ])('adaptive-capable model %s routes through adaptive path', async (model) => {
      const provider = createProvider(model).withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body['output_config']).toEqual({ effort: 'high' });
    });

    it.each([
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-20240620',
      'claude-haiku-4-5-20251001',
    ])('non-adaptive model %s does not emit adaptive thinking', async (model) => {
      const provider = createProvider(model).withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
      expect(body['output_config']).toBeUndefined();
    });

    it.each([
      // effort-supporting models: output_config present
      ['claude-opus-4-7', true],
      ['anthropic.claude-opus-4-5-v1:0', true],
      // non-effort-supporting models: output_config absent
      ['claude-3-5-sonnet-20240620', false],
      ['claude-haiku-4-5-20251001', false],
    ] as const)('supportsEffortParam wire body: %s -> output_config=%s', async (model, supports) => {
      const provider = createProvider(model).withThinking('high');
      const body = await captureRequestBody(provider, '', [], thinkHistory);

      if (supports) {
        expect(body['output_config']).toEqual({ effort: 'high' });
      } else {
        expect(body['output_config']).toBeUndefined();
      }
    });

    // Full adaptive-thinking coverage matrix. Adaptive models must
    // emit { type: 'adaptive' } and output_config; non-adaptive models
    // must fall back to legacy budget thinking.
    describe('supports adaptive thinking matrix', () => {
      it.each([
        // Opus 4.7 family (adaptive-only per Anthropic docs)
        'claude-opus-4-7',
        'claude-opus-4-7-20260301',
        'claude-opus-4.7',
        'CLAUDE-OPUS-4-7', // case-insensitive
        // Opus 4.6 / Sonnet 4.6
        'claude-opus-4-6',
        'claude-opus-4-6-20260205',
        'claude-opus-4.6',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6-20260301',
        'claude-sonnet-4.6',
        // Future version extrapolation
        'claude-opus-4-8',
        'claude-opus-4-9',
        'claude-opus-4-10',
        'claude-opus-5-0',
        'claude-opus-5-0-20270101',
        'claude-sonnet-5-0',
        'claude-haiku-4-6',
        'claude-haiku-5-0',
        // Fable (major-only version, no minor)
        'claude-fable-5',
        'anthropic.claude-fable-5-v1:0',
        // Bedrock / Vertex / proxy prefixes
        'anthropic.claude-opus-4-7-v1:0',
        'aws/claude-opus-4-7',
        'bedrock/anthropic.claude-opus-4-6-v1:0',
        'claude-opus-4-7@20260101',
      ])('adaptive: %s -> type=adaptive', async (model) => {
        const provider = createProvider(model).withThinking('high');
        const body = await captureRequestBody(provider, '', [], thinkHistory);

        expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      });

      it.each([
        // Pre-4.6 models (legacy budget_tokens required)
        'claude-opus-4',
        'claude-opus-4-0',
        'claude-opus-4-5',
        'claude-opus-4-5-20251001',
        'claude-opus-3-5',
        'claude-opus-3-5-sonnet-20241022',
        'claude-sonnet-4-20250514',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-3-5',
        'claude-sonnet-3-7',
        'claude-haiku-3-5',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
      ])('non-adaptive: %s -> type=enabled budget', async (model) => {
        const provider = createProvider(model).withThinking('high');
        const body = await captureRequestBody(provider, '', [], thinkHistory);

        expect(body['thinking']).toMatchObject({ type: 'enabled' });
        expect((body['thinking'] as { type: string }).type).not.toBe('adaptive');
      });

      it.each(['gpt-4', 'gpt-4-turbo', 'gemini-2.5-pro', 'unknown-model', 'claude'])(
        'unrecognized model %s uses the latest Opus adaptive profile',
        async (model) => {
          const provider = createProvider(model).withThinking('max');
          const body = await captureRequestBody(provider, '', [], thinkHistory);

          expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
          expect(body['output_config']).toEqual({ effort: 'max' });
        },
      );
    });

    // Effort handling per model capability: adaptive-capable models pass
    // concrete efforts through; legacy budget models can only express
    // low/medium/high.
    describe('effort matrix', () => {
      it.each([
        ['claude-opus-4-7', 'low', 'low'],
        ['claude-opus-4-7', 'medium', 'medium'],
        ['claude-opus-4-7', 'high', 'high'],
        ['claude-opus-4-7', 'xhigh', 'xhigh'],
        ['claude-opus-4-7', 'max', 'max'],
        ['claude-opus-4-7-20260301', 'xhigh', 'xhigh'],
        ['claude-opus-4-6', 'max', 'max'],
        ['claude-opus-4-6-20260205', 'max', 'max'],
        ['claude-sonnet-4-6', 'max', 'max'],
        ['claude-opus-4-6', 'medium', 'medium'],
        ['claude-fable-5', 'xhigh', 'xhigh'],
        ['claude-fable-5', 'max', 'max'],
        ['claude-opus-4-8', 'xhigh', 'xhigh'],
        ['claude-opus-4-8', 'max', 'max'],
        ['claude-opus-5-0', 'max', 'max'],
        ['claude-opus-5-0', 'xhigh', 'xhigh'],
      ] as const)(
        'adaptive pass-through: %s + %s -> effort=%s',
        async (model, effort, expected) => {
          const provider = createProvider(model).withThinking(effort);
          const body = await captureRequestBody(provider, '', [], thinkHistory);

          expect(body['output_config']).toEqual({ effort: expected });
        },
      );

      it.each([
        ['claude-opus-4-5', 'max'],
        ['claude-opus-4-5', 'xhigh'],
        ['claude-opus-4-6', 'xhigh'],
        ['claude-sonnet-4-20250514', 'max'],
        ['claude-sonnet-4-20250514', 'xhigh'],
        ['claude-sonnet-4-5', 'xhigh'],
        ['claude-sonnet-4-6', 'xhigh'],
        ['claude-haiku-4-5', 'max'],
      ] as const)(
        'legacy budget passes an unlisted effort through: %s + %s',
        async (model, effort) => {
          const body = await captureRequestBody(
            createProvider(model).withThinking(effort),
            '',
            [],
            thinkHistory,
          );
          expect(body['output_config']).toEqual({ effort });
        },
      );

      it.each([
        ['claude-opus-4-5', 'high', true],
        ['claude-sonnet-4-20250514', 'low', false],
      ] as const)(
        'legacy budget accepts supported effort: %s + %s (supports=%s)',
        async (model, effort, supports) => {
          const provider = createProvider(model).withThinking(effort);
          const body = await captureRequestBody(provider, '', [], thinkHistory);

          if (supports) {
            expect(body['output_config']).toEqual({ effort });
          } else {
            expect(body['output_config']).toBeUndefined();
          }
        },
      );

      it('represents boolean on with the legacy high token budget', async () => {
        const provider = createProvider('claude-sonnet-4-5').withThinking('on');
        const body = await captureRequestBody(provider, '', [], thinkHistory);

        expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
        expect(body['output_config']).toBeUndefined();
      });
    });

    // Effort-param gating: adaptive-capable models and explicit
    // allowlist entries (Opus 4.5 legacy) emit output_config; legacy
    // year-first names and Bedrock-prefixed legacy must not.
    describe('supports effort param matrix', () => {
      it.each([
        // Adaptive-capable: all support effort
        'claude-opus-4-7',
        'claude-opus-4-7-20260301',
        'claude-opus-4-6',
        'claude-opus-4-6-20260205',
        'claude-sonnet-4-6',
        'claude-opus-5-0',
        'gpt-4',
        'claude-2.1',
        // Opus 4.5 explicitly supports effort (legacy budget thinking + effort)
        'claude-opus-4-5',
        'claude-opus-4-5-20251001',
        'claude-opus-4.5',
        'anthropic.claude-opus-4-5-v1:0',
      ])('effort supported: %s -> output_config present', async (model) => {
        const provider = createProvider(model).withThinking('high');
        const body = await captureRequestBody(provider, '', [], thinkHistory);

        expect(body['output_config']).toEqual({ effort: 'high' });
      });

      it.each([
        // Sonnet/Haiku-4 (non-4.6): not explicitly listed → false
        'claude-sonnet-4-20250514',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
        // Claude 3.x family: predates effort param
        'claude-sonnet-3-7',
        'claude-sonnet-3-7-20250219',
        'claude-sonnet-3-5',
        'claude-opus-3-5',
        'claude-haiku-3-5',
        // Old naming format (year-first)
        'claude-3-opus-20240229',
        'claude-3-5-sonnet-20240620',
        'claude-3-5-haiku-20241022',
        // Bedrock + old format
        'anthropic.claude-3-5-sonnet-20240620-v1:0',
      ])('effort unsupported: %s -> output_config absent', async (model) => {
        const provider = createProvider(model).withThinking('high');
        const body = await captureRequestBody(provider, '', [], thinkHistory);

        expect(body['output_config']).toBeUndefined();
      });
    });
  });

  describe('metadata', () => {
    it('forwards metadata to the request', async () => {
      const provider = createProvider('k25', {
        user_id: 'test-session-id',
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['metadata']).toEqual({ user_id: 'test-session-id' });
    });

    it('omits metadata when not provided', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['metadata']).toBeUndefined();
    });
  });

  describe('thinkingEffort property', () => {
    it('returns null when no thinking configured', () => {
      const provider = createProvider();
      expect(provider.thinkingEffort).toBeNull();
    });

    it('opus-4-6 with thinking high -> "high" (adaptive)', () => {
      const provider = createProvider('claude-opus-4-6').withThinking('high');
      expect(provider.thinkingEffort).toBe('high');
    });

    it('opus-4-6 with thinking off -> "off"', () => {
      const provider = createProvider('claude-opus-4-6').withThinking('off');
      expect(provider.thinkingEffort).toBe('off');
    });

    it('opus-4-7 reports xhigh and max adaptive efforts', () => {
      const xhigh = createProvider('claude-opus-4-7').withThinking('xhigh');
      expect(xhigh.thinkingEffort).toBe('xhigh');

      const max = createProvider('claude-opus-4-7').withThinking('max');
      expect(max.thinkingEffort).toBe('max');
    });

    it('reports an officially supported adaptive effort verbatim', () => {
      const provider = createProvider('claude-sonnet-4-6').withThinking('max');
      expect(provider.thinkingEffort).toBe('max');
    });

    it('pre-4.6 budget-based efforts', () => {
      const low = createProvider('claude-sonnet-4-5').withThinking('low');
      expect(low.thinkingEffort).toBe('low');

      const med = createProvider('claude-sonnet-4-5').withThinking('medium');
      expect(med.thinkingEffort).toBe('medium');

      const high = createProvider('claude-sonnet-4-5').withThinking('high');
      expect(high.thinkingEffort).toBe('high');
    });
  });

  describe('provider properties', () => {
    it('has correct name and model', () => {
      const provider = createProvider();
      expect(provider.name).toBe('anthropic');
      expect(provider.modelName).toBe('k25');
    });

    it('withThinking returns a new instance', () => {
      const provider = createProvider();
      const newProvider = provider.withThinking('high');
      expect(newProvider).toBeInstanceOf(AnthropicChatProvider);
      expect(newProvider).not.toBe(provider);
    });
  });

  describe('non-stream response parsing', () => {
    it('yields text content from non-stream response', async () => {
      const provider = createProvider();
      (provider as any)._client.messages.create = vi.fn().mockResolvedValue({
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hello world' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      const parts = [];
      for await (const part of stream) {
        parts.push(part);
      }

      expect(parts).toEqual([{ type: 'text', text: 'Hello world' }]);
      expect(stream.id).toBe('msg_123');
      expect(stream.usage).toEqual({
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });

    it('yields thinking and tool_use from non-stream response', async () => {
      const provider = createProvider();
      (provider as any)._client.messages.create = vi.fn().mockResolvedValue({
        id: 'msg_456',
        content: [
          { type: 'thinking', thinking: 'Let me think...', signature: 'sig_abc' },
          { type: 'text', text: 'The answer is 4.' },
          { type: 'tool_use', id: 'tool_1', name: 'add', input: { a: 2, b: 3 } },
        ],
        usage: { input_tokens: 15, output_tokens: 10, cache_read_input_tokens: 5 },
      });

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'What is 2+3?' }], toolCalls: [] }],
      );

      const parts = [];
      for await (const part of stream) {
        parts.push(part);
      }

      expect(parts).toEqual([
        { type: 'think', think: 'Let me think...', encrypted: 'sig_abc' },
        { type: 'text', text: 'The answer is 4.' },
        {
          type: 'function',
          id: 'tool_1',
          name: 'add', arguments: '{"a":2,"b":3}',
        },
      ]);
      expect(stream.usage).toEqual({
        inputOther: 15,
        output: 10,
        inputCacheRead: 5,
        inputCacheCreation: 0,
      });
    });
  });

  describe('stream response parsing', () => {
    it('yields text delta from stream events', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: {
            id: 'msg_stream_001',
            usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.create = vi.fn().mockResolvedValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      const parts = await collectParts(result);

      expect(parts).toEqual([
        { type: 'text', text: '' },
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ]);
      expect(result.id).toBe('msg_stream_001');
      expect(result.usage).toEqual({
        inputOther: 10,
        output: 5,
        inputCacheRead: 3,
        inputCacheCreation: 2,
      });
    });

    it('yields thinking delta and signature from stream events', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_stream_002', usage: { input_tokens: 20 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: ' about this' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig_xyz' },
        },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'The answer is 4.' },
        },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 15 } },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.create = vi.fn().mockResolvedValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] }],
      );

      const parts = await collectParts(result);

      expect(parts).toEqual([
        { type: 'think', think: '' },
        { type: 'think', think: 'Let me think' },
        { type: 'think', think: ' about this' },
        { type: 'think', think: '', encrypted: 'sig_xyz' },
        { type: 'text', text: '' },
        { type: 'text', text: 'The answer is 4.' },
      ]);
      expect(result.id).toBe('msg_stream_002');
      expect(result.usage).toEqual({
        inputOther: 20,
        output: 15,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });

    it('normalizes a thinking delta with no thinking field to an empty ThinkPart', async () => {
      const parts = await collectAnthropicStreamParts([
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta' },
        },
      ]);

      expect(parts).toEqual([{ type: 'think', think: '' }]);
    });

    it('normalizes a thinking block start with no thinking field to an empty ThinkPart', async () => {
      const parts = await collectAnthropicStreamParts([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
      ]);

      expect(parts).toEqual([{ type: 'think', think: '' }]);
    });

    it('yields tool_use start and argument deltas from stream events', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_stream_003', usage: { input_tokens: 15 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: "I'll add those." },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_abc', name: 'add' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"a":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '2,"b":3}' },
        },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.create = vi.fn().mockResolvedValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] }],
      );

      const parts = await collectParts(result);

      expect(parts).toEqual([
        { type: 'text', text: '' },
        { type: 'text', text: "I'll add those." },
        {
          type: 'function',
          id: 'toolu_abc',
          name: 'add', arguments: '',
          _streamIndex: 1,
        },
        { type: 'tool_call_part', argumentsPart: '{"a":', index: 1 },
        { type: 'tool_call_part', argumentsPart: '2,"b":3}', index: 1 },
      ]);
      expect(result.id).toBe('msg_stream_003');
    });

    it('streaming: parallel tool_use blocks route input_json_delta by block index', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_parallel_001', usage: { input_tokens: 10 } },
        },
        // Two tool_use blocks opened in order at index 0 and 1.
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_a', name: 'tool_a', input: {} },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_b', name: 'tool_b', input: {} },
        },
        // Interleaved input_json_delta chunks across the two blocks.
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"x":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"y":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '1}' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '2}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.create = vi.fn().mockResolvedValue(stream) as never;

      const result = await provider.generate(
        '',
        [ADD_TOOL, MUL_TOOL],
        [{ role: 'user', content: [{ type: 'text', text: 'Run both tools' }], toolCalls: [] }],
      );

      // Raw stream parts carry block index on both ToolCall and ToolCallPart.
      // The Anthropic adapter absorbs `content_block_stop` for tool_use blocks
      // internally — generate.ts infers completion from merge boundaries.
      const parts = await collectParts(result);
      expect(parts).toEqual([
        {
          type: 'function',
          id: 'toolu_a',
          name: 'tool_a', arguments: '',
          _streamIndex: 0,
        },
        {
          type: 'function',
          id: 'toolu_b',
          name: 'tool_b', arguments: '',
          _streamIndex: 1,
        },
        { type: 'tool_call_part', argumentsPart: '{"x":', index: 0 },
        { type: 'tool_call_part', argumentsPart: '{"y":', index: 1 },
        { type: 'tool_call_part', argumentsPart: '1}', index: 0 },
        { type: 'tool_call_part', argumentsPart: '2}', index: 1 },
      ]);
    });

    it('streaming: generate() assembles parallel tool calls via index routing', async () => {
      // End-to-end: verify that generate() routes interleaved deltas to the
      // correct ToolCall using the block index, producing fully-assembled
      // arguments per tool.
      const { generate } = await import('#/generate');

      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_parallel_002', usage: { input_tokens: 10 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_a', name: 'tool_a', input: {} },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_b', name: 'tool_b', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"x":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"y":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '1}' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '2}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.create = vi.fn().mockResolvedValue(stream) as never;

      const { message } = await generate(
        provider,
        '',
        [ADD_TOOL, MUL_TOOL],
        [{ role: 'user', content: [{ type: 'text', text: 'Run both' }], toolCalls: [] }],
      );

      expect(message.toolCalls.length).toBe(2);
      expect(message.toolCalls[0]!.id).toBe('toolu_a');
      expect(message.toolCalls[0]!.name).toBe('tool_a');
      expect(message.toolCalls[0]!.arguments).toBe('{"x":1}');
      expect(message.toolCalls[1]!.id).toBe('toolu_b');
      expect(message.toolCalls[1]!.name).toBe('tool_b');
      expect(message.toolCalls[1]!.arguments).toBe('{"y":2}');
      // _streamIndex should be stripped from stored tool calls.
      expect(
        (message.toolCalls[0] as ToolCall & { _streamIndex?: number })._streamIndex,
      ).toBeUndefined();
      expect(
        (message.toolCalls[1] as ToolCall & { _streamIndex?: number })._streamIndex,
      ).toBeUndefined();
    });

    it('converts stream errors to ChatProviderError', async () => {
      const provider = createStreamProvider();
      const errorStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'message_start',
            message: { id: 'msg_err', usage: { input_tokens: 5 } },
          };
          throw new Error('stream interrupted');
        },
      };

      (provider as any)._client.messages.create = vi.fn().mockResolvedValue(errorStream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      await expect(collectParts(result)).rejects.toThrow(ChatProviderError);
    });

    it('updates usage from message_delta with all fields', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: {
            id: 'msg_usage',
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 20,
            },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        {
          type: 'message_delta',
          delta: {},
          usage: {
            output_tokens: 42,
            cache_read_input_tokens: 55,
            cache_creation_input_tokens: 25,
            input_tokens: 105,
          },
        },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.create = vi.fn().mockResolvedValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      await collectParts(result);

      expect(result.usage).toEqual({
        inputOther: 105,
        output: 42,
        inputCacheRead: 55,
        inputCacheCreation: 25,
      });
    });

    it('redacted_thinking block yields encrypted think part', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_redacted', usage: { input_tokens: 10 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'redacted_thinking', data: 'enc_data_123' },
        },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.create = vi.fn().mockResolvedValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] }],
      );

      const parts = await collectParts(result);

      expect(parts).toEqual([
        { type: 'think', think: '', encrypted: 'enc_data_123' },
        { type: 'text', text: '' },
        { type: 'text', text: 'Done.' },
      ]);
    });
  });

  describe('stream option', () => {
    it('defaults to stream: true and calls messages.create with stream enabled', async () => {
      const provider = new AnthropicChatProvider({
        model: 'k25',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
      });

      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_default', usage: { input_tokens: 5 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_stop' },
      ]);

      const createFn = vi.fn().mockResolvedValue(stream);
      (provider as any)._client.messages.create = createFn as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      await collectParts(result);

      expect(createFn).toHaveBeenCalledTimes(1);
      expect(createFn.mock.calls[0]?.[0]).toMatchObject({ stream: true });
    });

    it('stream: false calls messages.create', async () => {
      const provider = createProvider(); // stream: false
      const createFn = vi.fn().mockResolvedValue(makeAnthropicResponse());
      (provider as any)._client.messages.create = createFn as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      await collectParts(result);

      expect(createFn).toHaveBeenCalledTimes(1);
      // Verify stream: false is in the params
      const params = createFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(params['stream']).toBe(false);
    });
  });

  describe('modelParameters getter', () => {
    it('returns model + generation kwargs', () => {
      const provider = new AnthropicChatProvider({
        model: 'k25',
        apiKey: 'test-key',
        defaultMaxTokens: 2048,
      }).withGenerationKwargs({ temperature: 0.5 });

      const params = provider.modelParameters;
      expect(params).toMatchObject({
        model: 'k25',
        temperature: 0.5,
      });
    });
  });

  describe('generate without system prompt', () => {
    it('omits the system array when systemPrompt is empty string', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      expect(body['system']).toBeUndefined();
    });
  });
});

describe('resolveDefaultMaxTokens', () => {
  it('returns per-version Messages-API caps for known Claude 4 models', () => {
    expect(resolveDefaultMaxTokens('claude-fable-5')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-5-20251101')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-opus-4-1-20250805')).toBe(32000);
    expect(resolveDefaultMaxTokens('claude-opus-4-20250514')).toBe(32000);
    expect(resolveDefaultMaxTokens('claude-sonnet-5')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-5-20250929')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-20250514')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-5-20251001')).toBe(64000);
  });

  it('returns the right ceiling for Claude 3.5 / 3.7 (both naming orders)', () => {
    // version-first (legacy Anthropic id form)
    expect(resolveDefaultMaxTokens('claude-3-5-sonnet-20240620')).toBe(8192);
    expect(resolveDefaultMaxTokens('claude-3.5-sonnet')).toBe(8192);
    expect(resolveDefaultMaxTokens('claude-3-7-sonnet')).toBe(8192);
    expect(resolveDefaultMaxTokens('claude-3.7-sonnet')).toBe(8192);
    // family-first (used throughout this repo's tests)
    expect(resolveDefaultMaxTokens('claude-sonnet-3-7')).toBe(8192);
    expect(resolveDefaultMaxTokens('claude-sonnet-3-5')).toBe(8192);
    expect(resolveDefaultMaxTokens('claude-opus-3-5')).toBe(8192);
    expect(resolveDefaultMaxTokens('claude-haiku-3-5')).toBe(8192);
  });

  it('returns 4096 for original Claude 3', () => {
    expect(resolveDefaultMaxTokens('claude-3-opus-20240229')).toBe(4096);
    expect(resolveDefaultMaxTokens('claude-3-sonnet-20240229')).toBe(4096);
    expect(resolveDefaultMaxTokens('claude-3-haiku-20240307')).toBe(4096);
  });

  it('matches dotted version separators', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4.8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4.7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4.6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4.6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-haiku-4.5')).toBe(64000);
  });

  it('matches vendor-prefixed and suffixed third-party variants', () => {
    // Bedrock / Vertex / proxy prefixes
    expect(resolveDefaultMaxTokens('anthropic.claude-opus-4-7-v1:0')).toBe(128000);
    expect(resolveDefaultMaxTokens('aws/claude-opus-4-7')).toBe(128000);
    expect(resolveDefaultMaxTokens('vertex_ai/claude-opus-4-7')).toBe(128000);
    expect(resolveDefaultMaxTokens('bedrock/anthropic.claude-opus-4-6-v1:0')).toBe(128000);
    // OpenRouter / proxy-style prefixes the user has seen in the wild
    expect(resolveDefaultMaxTokens('openrouter/claude-opus-4-7')).toBe(128000);
    expect(resolveDefaultMaxTokens('online-claude-opus-4-7')).toBe(128000);
    // Build / variant suffixes
    expect(resolveDefaultMaxTokens('claude-opus-4-6-construct')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-5-20250929')).toBe(64000);
    // Legacy id buried inside a vendor prefix
    expect(resolveDefaultMaxTokens('anthropic.claude-3-5-sonnet-20240620-v1:0')).toBe(8192);
  });

  it('falls back to the nearest lower catalogued minor for unknown minors', () => {
    // opus-4-9/4-10 are not in the table; they reuse opus-4-8's 128k
    // ceiling (a newer minor inherits at least its predecessor's cap).
    expect(resolveDefaultMaxTokens('claude-opus-4-9')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-10')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-9')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-9')).toBe(64000);
    // A gap between catalogued minors also resolves to the nearest lower one.
    expect(resolveDefaultMaxTokens('claude-opus-4-3')).toBe(32000);
  });

  it('matches case-insensitively', () => {
    expect(resolveDefaultMaxTokens('CLAUDE-OPUS-4-7')).toBe(128000);
    expect(resolveDefaultMaxTokens('Claude-Sonnet-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('Anthropic.Claude-Opus-4-7-v1:0')).toBe(128000);
  });

  it('honors the override for unknown models', () => {
    expect(resolveDefaultMaxTokens('unknown-model', 12345)).toBe(12345);
    expect(resolveDefaultMaxTokens('unknown-preview-001', 16000)).toBe(16000);
  });

  it('honors a lower override on known models (intentional truncation)', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 200)).toBe(200);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-6', 1024)).toBe(1024);
    expect(resolveDefaultMaxTokens('claude-3-opus', 1000)).toBe(1000);
  });

  it('clamps an override above the documented ceiling for known models', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 999999)).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-6', 200000)).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-3-opus', 99999)).toBe(4096);
  });

  it('falls back to the latest Opus 128k ceiling when both lookup and override miss', () => {
    expect(resolveDefaultMaxTokens('totally-unknown-model')).toBe(128000);
    expect(resolveDefaultMaxTokens('gpt-5')).toBe(128000);
  });

  it('does not apply Claude ceilings to non-Claude ids that contain an opus/sonnet/haiku token', () => {
    // No "claude" marker → fall through to the override / fallback rather
    // than quietly applying a Claude ceiling to a fine-tune or unrelated model.
    expect(resolveDefaultMaxTokens('vendor-opus-4-7-preview')).toBe(128000);
    expect(resolveDefaultMaxTokens('vendor-opus-4-7-preview', 8000)).toBe(8000);
  });
});

describe('AnthropicChatProvider constructor max_tokens', () => {
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
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);
    return body['max_tokens'] as number;
  }

  it('uses per-version Messages-API caps for known Claude 4 models', async () => {
    expect(await maxTokensFor('claude-opus-4-7')).toBe(128000);
    expect(await maxTokensFor('claude-opus-4-6')).toBe(128000);
    expect(await maxTokensFor('claude-opus-4-5')).toBe(64000);
    expect(await maxTokensFor('claude-sonnet-4-6')).toBe(128000);
    expect(await maxTokensFor('claude-haiku-4-5-20251001')).toBe(64000);
  });

  it('uses 4096 for Claude 3', async () => {
    expect(await maxTokensFor('claude-3-opus-20240229')).toBe(4096);
  });

  it('honors defaultMaxTokens for unknown models', async () => {
    expect(await maxTokensFor('unknown-model', { defaultMaxTokens: 12345 })).toBe(12345);
  });

  it('uses the 128k fallback for unknown models without an override', async () => {
    expect(await maxTokensFor('unknown-model')).toBe(128000);
  });

  it('lets defaultMaxTokens lower the budget for known models', async () => {
    expect(await maxTokensFor('claude-opus-4-7', { defaultMaxTokens: 200 })).toBe(200);
  });

  it('honors explicit defaultMaxTokens above the ceiling for known models', async () => {
    expect(await maxTokensFor('claude-opus-4-7', { defaultMaxTokens: 999999 })).toBe(999999);
  });

  it('withMaxCompletionTokens sets max_tokens when no existing cap is present', async () => {
    const original = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'test-key',
      stream: false,
    });
    const provider = original
      .withGenerationKwargs({ max_tokens: undefined })
      .withMaxCompletionTokens(2048);
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);

    expect(provider).not.toBe(original);
    expect(body['max_tokens']).toBe(2048);
    expect(provider.maxCompletionTokens).toBe(2048);
  });

  it('exposes the constructor-resolved max_tokens without any budget application', async () => {
    // max_tokens is required by the Messages API, so even when completion
    // budgeting is disabled the wire carries the constructor default; the
    // exposed cap must reflect it for the request trace.
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'test-key',
      stream: false,
    });
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);

    expect(provider.maxCompletionTokens).toBeDefined();
    expect(provider.maxCompletionTokens).toBe(body['max_tokens']);
  });

  it('withMaxCompletionTokens lowers the inferred model default cap', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'test-key',
      stream: false,
    }).withMaxCompletionTokens(8192);
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);

    expect(body['max_tokens']).toBe(8192);
  });

  it('withMaxCompletionTokens preserves an existing lower max_tokens cap', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'test-key',
      stream: false,
      defaultMaxTokens: 1024,
    }).withMaxCompletionTokens(128000);
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);

    expect(body['max_tokens']).toBe(1024);
    // The exposed effective cap tracks the preserved existing value, not the
    // requested budget — the request trace records this field.
    expect(provider.maxCompletionTokens).toBe(1024);
  });

  it('withMaxCompletionTokens preserves an existing higher max_tokens cap', async () => {
    const provider = new AnthropicChatProvider({
      model: 'unknown-model',
      apiKey: 'test-key',
      stream: false,
      defaultMaxTokens: 128000,
    }).withMaxCompletionTokens(1024);
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);

    expect(body['max_tokens']).toBe(128000);
  });

  it('withMaxCompletionTokens preserves explicit defaultMaxTokens above the ceiling for known models', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'test-key',
      stream: false,
      defaultMaxTokens: 999999,
    }).withMaxCompletionTokens(1024);
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);

    expect(body['max_tokens']).toBe(999999);
  });

  it('withMaxCompletionTokens clamps above the documented ceiling for known models', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'test-key',
      stream: false,
    }).withMaxCompletionTokens(999999);
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);

    expect(body['max_tokens']).toBe(128000);
  });
});
