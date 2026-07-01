import { generate } from '#/generate';
import type { ContentPart, Message, ToolCall } from '#/message';
import { extractUsageFromChunk, KimiChatProvider } from '#/providers/kimi';
import { extractUsage } from '#/providers/openai-common';
import type { Tool } from '#/tool';
import { describe, it, expect, vi } from 'vitest';

function makeChatCompletionResponse(model: string = 'test-model') {
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

function createProvider(
  stream: boolean = false,
  supportEfforts?: readonly string[],
): KimiChatProvider {
  return new KimiChatProvider({
    model: 'kimi-k2-turbo-preview',
    apiKey: 'test-key',
    stream,
    supportEfforts,
  });
}

type KimiGenerationState = {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  prompt_cache_key?: string | undefined;
  extra_body?: Record<string, unknown> | undefined;
};

function getGenerationState(provider: KimiChatProvider): KimiGenerationState {
  return Reflect.get(provider, '_generationKwargs') as KimiGenerationState;
}

/** Capture the request body sent to OpenAI by mocking the client. */
async function captureRequestBody(
  provider: KimiChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | undefined;

  (provider as any)._client.chat.completions.create = vi
    .fn()
    .mockImplementation((params: unknown) => {
      capturedBody = params as Record<string, unknown>;
      return Promise.resolve(makeChatCompletionResponse('kimi-k2'));
    });

  const stream = await provider.generate(systemPrompt, tools, history);
  for await (const part of stream) {
    void part;
  }

  if (capturedBody === undefined) {
    throw new Error('Expected provider.generate() to call chat.completions.create');
  }
  return capturedBody;
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

const BUILTIN_TOOL: Tool = {
  name: '$web_search',
  description: 'Search the web',
  parameters: { type: 'object', properties: {} },
};

const JETBRAINS_ENUM_ONLY_TOOL: Tool = {
  name: 'replace_text',
  description: 'Replace text in a file.',
  parameters: {
    type: 'object',
    properties: {
      truncateMode: { enum: ['none', 'start', 'end'] },
      startLine: { minimum: 1 },
      externalHint: { description: 'Optional vendor-specific hint.' },
      replacement: { type: 'string' },
    },
    required: ['replacement'],
  },
};

const REF_ENUM_ONLY_TOOL: Tool = {
  name: 'choose_mode',
  description: 'Choose a mode.',
  parameters: {
    type: 'object',
    properties: {
      mode: { $ref: '#/definitions/Mode' },
      tuple: {
        prefixItems: [{ enum: ['left', 'right'] }],
      },
    },
    definitions: {
      Mode: { enum: ['fast', 'safe'] },
    },
  },
};

describe('KimiChatProvider', () => {
  describe('message conversion', () => {
    it('simple user message with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are helpful.', [], history);

      expect(body['messages']).toEqual([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello!' },
      ]);
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
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '2+2 equals 4.' },
        { role: 'user', content: 'And 3+3?' },
      ]);
    });

    it('multi-turn with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are a math tutor.', [], history);

      expect(body['messages']).toEqual([
        { role: 'system', content: 'You are a math tutor.' },
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '2+2 equals 4.' },
        { role: 'user', content: 'And 3+3?' },
      ]);
    });

    it('image url content', async () => {
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
            { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
          ],
        },
      ]);
    });

    it('tool definitions', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      expect(body['tools']).toEqual([
        {
          type: 'function',
          function: {
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
          },
        },
        {
          type: 'function',
          function: {
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
          },
        },
      ]);
    });

    it('adds Kimi-only types to JetBrains-like enum-only tool parameters without mutation', async () => {
      const provider = createProvider();
      const originalParameters = structuredClone(JETBRAINS_ENUM_ONLY_TOOL.parameters);
      const history: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Replace the selected range' }],
          toolCalls: [],
        },
      ];

      const body = await captureRequestBody(provider, '', [JETBRAINS_ENUM_ONLY_TOOL], history);

      expect(body['tools']).toEqual([
        {
          type: 'function',
          function: {
            name: 'replace_text',
            description: 'Replace text in a file.',
            parameters: {
              type: 'object',
              properties: {
                truncateMode: { enum: ['none', 'start', 'end'], type: 'string' },
                startLine: { minimum: 1, type: 'number' },
                externalHint: { description: 'Optional vendor-specific hint.', type: 'string' },
                replacement: { type: 'string' },
              },
              required: ['replacement'],
            },
          },
        },
      ]);
      expect(JETBRAINS_ENUM_ONLY_TOOL.parameters).toEqual(originalParameters);
    });

    it('dereferences draft-7 definitions and normalizes referenced enum-only schemas for Kimi', async () => {
      const provider = createProvider();
      const originalParameters = structuredClone(REF_ENUM_ONLY_TOOL.parameters);
      const history: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Choose fast mode' }],
          toolCalls: [],
        },
      ];

      const body = await captureRequestBody(provider, '', [REF_ENUM_ONLY_TOOL], history);

      expect(body['tools']).toEqual([
        {
          type: 'function',
          function: {
            name: 'choose_mode',
            description: 'Choose a mode.',
            parameters: {
              type: 'object',
              properties: {
                mode: { enum: ['fast', 'safe'], type: 'string' },
                tuple: {
                  type: 'array',
                  prefixItems: [{ enum: ['left', 'right'], type: 'string' }],
                },
              },
            },
          },
        },
      ]);
      expect(REF_ENUM_ONLY_TOOL.parameters).toEqual(originalParameters);
    });

    it('tool call and tool result', async () => {
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_abc123',
        name: 'add',
        arguments: '{"a": 2, "b": 3}',
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

      expect(body['messages']).toEqual([
        { role: 'user', content: 'Add 2 and 3' },
        {
          role: 'assistant',
          content: "I'll add those numbers for you.",
          tool_calls: [
            {
              type: 'function',
              id: 'call_abc123',
              function: { name: 'add', arguments: '{"a": 2, "b": 3}' },
            },
          ],
        },
        { role: 'tool', content: '5', tool_call_id: 'call_abc123' },
      ]);
    });

    it('normalizes invalid historical tool call ids and matching tool results', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Read a file' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'Read:9',
              name: 'Read',
              arguments: '{"path":"/tmp/file"}',
            },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'content' }],
          toolCallId: 'Read:9',
          toolCalls: [],
        },
      ];

      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        { role: 'user', content: 'Read a file' },
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              id: 'Read_9',
              function: { name: 'Read', arguments: '{"path":"/tmp/file"}' },
            },
          ],
        },
        { role: 'tool', content: 'content', tool_call_id: 'Read_9' },
      ]);
    });

    it('tool call with image result', async () => {
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_abc123',
        name: 'add',
        arguments: '{"a": 2, "b": 3}',
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

      expect((body['messages'] as unknown[])[2]).toEqual({
        role: 'tool',
        content: [
          { type: 'text', text: '5' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
        ],
        tool_call_id: 'call_abc123',
      });
    });

    it('parallel tool calls', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Calculate 2+3 and 4*5' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll calculate both." }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_add',
              name: 'add',
              arguments: '{"a": 2, "b": 3}',
            },
            {
              type: 'function',
              id: 'call_mul',
              name: 'multiply',
              arguments: '{"a": 4, "b": 5}',
            },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: '<system-reminder>This is a system reminder</system-reminder>' },
            { type: 'text', text: '5' },
          ],
          toolCallId: 'call_add',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: '<system-reminder>This is a system reminder</system-reminder>' },
            { type: 'text', text: '20' },
          ],
          toolCallId: 'call_mul',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      // Snapshot of the expected wire format:
      // - 4 messages in order
      // - user / assistant use compressed string content
      // - both tool messages preserve multi-part content arrays
      expect(body['messages']).toEqual([
        { role: 'user', content: 'Calculate 2+3 and 4*5' },
        {
          role: 'assistant',
          content: "I'll calculate both.",
          tool_calls: [
            {
              type: 'function',
              id: 'call_add',
              function: { name: 'add', arguments: '{"a": 2, "b": 3}' },
            },
            {
              type: 'function',
              id: 'call_mul',
              function: { name: 'multiply', arguments: '{"a": 4, "b": 5}' },
            },
          ],
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
          tool_call_id: 'call_add',
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
          tool_call_id: 'call_mul',
        },
      ]);
      expect(body['tools']).toHaveLength(2);
    });

    it('builtin tool ($web_search)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Search for something' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [BUILTIN_TOOL], history);

      expect(body['tools']).toEqual([
        {
          type: 'builtin_function',
          function: { name: '$web_search' },
        },
      ]);
    });

    it('assistant with reasoning content', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Let me think...' },
            { type: 'text', text: 'The answer is 4.' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Thanks!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      // Snapshot of the expected wire format.
      // Kimi injects ThinkPart as `reasoning_content` field on the
      // assistant message (Moonshot API extension).
      expect(body['messages']).toEqual([
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: 'The answer is 4.',
          reasoning_content: 'Let me think...',
        },
        { role: 'user', content: 'Thanks!' },
      ]);
    });
  });

  describe('generation kwargs', () => {
    it('applies temperature and normalizes legacy max_tokens to max_completion_tokens', async () => {
      const provider = createProvider().withGenerationKwargs({
        temperature: 0.7,
        max_tokens: 2048,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['temperature']).toBe(0.7);
      // `max_tokens` is the legacy alias; the provider rewrites it on the wire
      // so reasoning models do not interpret it as a thinking-budget cap.
      expect(body['max_completion_tokens']).toBe(2048);
      expect(body['max_tokens']).toBeUndefined();
    });

    it('sends no completion-token cap by default — upstream is responsible for clamping', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['max_tokens']).toBeUndefined();
      expect(body['max_completion_tokens']).toBeUndefined();
    });

    it('forwards max_completion_tokens verbatim', async () => {
      const provider = createProvider().withGenerationKwargs({
        max_completion_tokens: 2048,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['max_completion_tokens']).toBe(2048);
      expect(body['max_tokens']).toBeUndefined();
    });

    it('prefers max_completion_tokens when both fields are set', async () => {
      const provider = createProvider().withGenerationKwargs({
        max_completion_tokens: 2048,
        max_tokens: 4096,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['max_completion_tokens']).toBe(2048);
      expect(body['max_tokens']).toBeUndefined();
    });

    it('withMaxCompletionTokens sets max_completion_tokens on the cloned provider', async () => {
      const provider = createProvider().withMaxCompletionTokens(1024);
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['max_completion_tokens']).toBe(1024);
      expect(body['max_tokens']).toBeUndefined();
    });

    it('withMaxCompletionTokens sizes the cap to the remaining context window', async () => {
      const provider = createProvider().withMaxCompletionTokens(100000, {
        usedContextTokens: 30000,
        maxContextTokens: 100000,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['max_completion_tokens']).toBe(70000);
    });

    it('passes constructor generation kwargs into the request body', async () => {
      const provider = new KimiChatProvider({
        model: 'kimi-k2-turbo-preview',
        apiKey: 'test-key',
        stream: false,
        generationKwargs: { prompt_cache_key: 'session-test' },
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['prompt_cache_key']).toBe('session-test');
    });

    it('combines thinking and max_tokens in internal state', () => {
      const provider = createProvider()
        .withThinking('high')
        .withGenerationKwargs({ max_tokens: 512 });

      expect(getGenerationState(provider)).toEqual({
        extra_body: {
          thinking: { type: 'enabled', effort: 'high' },
        },
        max_tokens: 512,
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

    it('shallow-merges repeated withGenerationKwargs calls and replaces extra_body wholesale', () => {
      const provider = createProvider()
        .withGenerationKwargs({
          temperature: 0.1,
          extra_body: { first: true },
        })
        .withGenerationKwargs({
          max_tokens: 512,
          extra_body: { second: true },
        });

      expect(getGenerationState(provider)).toEqual({
        temperature: 0.1,
        max_tokens: 512,
        extra_body: { second: true },
      });
    });
  });

  describe('with thinking', () => {
    it('model without support_efforts passes the requested effort through', async () => {
      const provider = createProvider().withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning_effort']).toBeUndefined();
      expect(body['thinking']).toEqual({ type: 'enabled', effort: 'high' });
      expect(body['extra_body']).toBeUndefined();
    });

    it('effort-capable model sends thinking.effort', async () => {
      const provider = createProvider(false, ['low', 'high', 'max']).withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['thinking']).toEqual({ type: 'enabled', effort: 'high' });
      expect(body['extra_body']).toBeUndefined();
    });

    it('effort-capable model passes max through to thinking.effort (no clamp)', async () => {
      const provider = createProvider(false, ['low', 'high', 'max']).withThinking('max');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['thinking']).toEqual({ type: 'enabled', effort: 'max' });
    });

    it('hoists thinking disabled and clears reasoning_effort for off', async () => {
      const provider = createProvider(false, ['low', 'high', 'max']).withThinking('off');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning_effort']).toBeUndefined();
      expect(body['thinking']).toEqual({ type: 'disabled' });
      expect(body['extra_body']).toBeUndefined();
    });

    it('effort-capable model omits effort for efforts not declared in support_efforts', async () => {
      // 'xhigh' / 'on' / 'foo' are not in ['low', 'high', 'max'], so the
      // provider normalizes them to "enabled, no effort" instead of rejecting.
      for (const effort of ['xhigh', 'on', 'foo']) {
        const provider = createProvider(false, ['low', 'high', 'max']).withThinking(effort);
        const history: Message[] = [
          { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
        ];
        const body = await captureRequestBody(provider, '', [], history);
        expect(body['reasoning_effort']).toBeUndefined();
        expect(body['thinking']).toEqual({ type: 'enabled' });
      }
    });

    it('thinkingEffort property reflects the configured effort', () => {
      const provider = createProvider(false, ['low', 'high', 'max']);
      expect(provider.thinkingEffort).toBeNull();

      expect(provider.withThinking('high').thinkingEffort).toBe('high');
      expect(provider.withThinking('low').thinkingEffort).toBe('low');
      expect(provider.withThinking('max').thinkingEffort).toBe('max');
      expect(provider.withThinking('off').thinkingEffort).toBe('off');
    });

    it('thinkingEffort reflects the requested effort when support_efforts is absent', () => {
      const provider = createProvider();
      expect(provider.withThinking('high').thinkingEffort).toBe('high');
      expect(provider.withThinking('on').thinkingEffort).toBe('on');
    });

    it('replaces the previous thinking effort when called again', () => {
      const provider = createProvider(false, ['low', 'high', 'max'])
        .withThinking('high')
        .withThinking('off');

      // No stale `effort` lingers on the disabled thinking object.
      expect(getGenerationState(provider)).toEqual({
        extra_body: {
          thinking: { type: 'disabled' },
        },
      });
    });
  });

  describe('provider properties', () => {
    it('has correct name and model', () => {
      const provider = createProvider();
      expect(provider.name).toBe('kimi');
      expect(provider.modelName).toBe('kimi-k2-turbo-preview');
    });

    it('throws during generation when no constructor or request API key is provided', async () => {
      // Save and clear env var
      const saved = process.env['KIMI_API_KEY'];
      delete process.env['KIMI_API_KEY'];
      try {
        const provider = new KimiChatProvider({ model: 'test' });
        await expect(provider.generate('', [], [])).rejects.toThrow(/options\.auth\.apiKey/);
      } finally {
        if (saved !== undefined) {
          process.env['KIMI_API_KEY'] = saved;
        }
      }
    });

    it('passes request-scoped auth to the client factory', async () => {
      const auths: unknown[] = [];
      const client = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue(makeChatCompletionResponse('kimi-k2')),
          },
        },
      };
      const provider = new KimiChatProvider({
        model: 'test',
        stream: false,
        clientFactory: (auth) => {
          auths.push(auth);
          return client as never;
        },
      });

      const stream = await provider.generate('', [], [], {
        auth: { apiKey: 'request-token' },
      });
      for await (const part of stream) {
        void part;
      }

      expect(auths).toEqual([{ apiKey: 'request-token' }]);
      expect(client.chat.completions.create).toHaveBeenCalledOnce();
    });

    it('withThinking returns a new instance', () => {
      const provider = createProvider();
      const newProvider = provider.withThinking('high');
      expect(newProvider).toBeInstanceOf(KimiChatProvider);
      expect(newProvider).not.toBe(provider);
    });

    it('withGenerationKwargs returns a new instance', () => {
      const provider = createProvider();
      const newProvider = provider.withGenerationKwargs({ temperature: 0.5 });
      expect(newProvider).toBeInstanceOf(KimiChatProvider);
      expect(newProvider).not.toBe(provider);
    });

    it('withGenerationKwargs does not mutate the original', () => {
      const provider = createProvider();
      const newProvider = provider.withGenerationKwargs({ temperature: 0.5 });
      expect(getGenerationState(provider)).toEqual({});
      expect(getGenerationState(newProvider)).toEqual({ temperature: 0.5 });
    });
  });

  describe('clone client sharing', () => {
    // The original and clone MUST share the underlying OpenAI client.
    // The dynamic completion budget path (KosongLLM.chatOnce) clones the
    // provider on every step. If a future change introduces a retry path
    // that replaces `clone._client` and closes the previous one, the
    // original instance's `_client` would become a dangling reference to
    // a closed socket. Lock in the invariant here.
    function getInternalClient(provider: KimiChatProvider): unknown {
      return Reflect.get(provider, '_client');
    }

    it('withGenerationKwargs clone shares the same OpenAI client as the original', () => {
      const original = createProvider();
      const clone = original.withGenerationKwargs({ max_completion_tokens: 1024 });
      expect(getInternalClient(clone)).not.toBeUndefined();
      expect(Object.is(getInternalClient(clone), getInternalClient(original))).toBe(true);
    });

    it('withMaxCompletionTokens clone shares the same OpenAI client as the original', () => {
      const original = createProvider();
      const clone = original.withMaxCompletionTokens(2048);
      expect(getInternalClient(clone)).not.toBeUndefined();
      expect(Object.is(getInternalClient(clone), getInternalClient(original))).toBe(true);
    });

    it('withThinking clone shares the same OpenAI client as the original', () => {
      const original = createProvider();
      const clone = original.withThinking('high');
      expect(getInternalClient(clone)).not.toBeUndefined();
      expect(Object.is(getInternalClient(clone), getInternalClient(original))).toBe(true);
    });
  });

  describe('non-stream response parsing', () => {
    it('yields text content from non-stream response', async () => {
      const provider = createProvider();
      (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue({
        id: 'chatcmpl-123',
        choices: [{ message: { role: 'assistant', content: 'Hello world' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
      expect(stream.id).toBe('chatcmpl-123');
      expect(stream.usage).toEqual({
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });

    it('yields reasoning_content as ThinkPart', async () => {
      const provider = createProvider();
      (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue({
        id: 'chatcmpl-123',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'The answer is 4.',
              reasoning_content: 'Let me think about this...',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] }],
      );

      const parts = [];
      for await (const part of stream) {
        parts.push(part);
      }

      expect(parts).toEqual([
        { type: 'think', think: 'Let me think about this...' },
        { type: 'text', text: 'The answer is 4.' },
      ]);
    });
  });

  describe('streaming tool call routing', () => {
    interface MockToolCallDelta {
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }

    function makeChunk(
      toolCalls: MockToolCallDelta[],
      opts?: { finishReason?: string; usage?: boolean },
    ): Record<string, unknown> {
      const chunk: Record<string, unknown> = {
        id: 'chatcmpl-kimi-stream',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: 'kimi-k2-turbo-preview',
        choices: [
          {
            index: 0,
            delta: { tool_calls: toolCalls },
            finish_reason: opts?.finishReason ?? null,
          },
        ],
      };
      if (opts?.usage) {
        chunk['usage'] = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
      }
      return chunk;
    }

    async function* mockStream(
      chunks: Record<string, unknown>[],
    ): AsyncIterable<Record<string, unknown>> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    it('buffers indexed argument deltas until the real tool name arrives', async () => {
      const provider = createProvider(true);

      const chunks = [
        makeChunk([{ index: 0, id: 'call_delayed', function: { name: '', arguments: '' } }]),
        makeChunk([{ index: 0, function: { arguments: '{"a' } }]),
        makeChunk([{ index: 0, function: { name: 'foo' } }]),
        makeChunk([{ index: 0, function: { arguments: '":1}' } }]),
        makeChunk([], { finishReason: 'tool_calls', usage: true }),
      ];

      (
        provider as unknown as { _client: { chat: { completions: { create: unknown } } } }
      )._client.chat.completions.create = vi.fn().mockResolvedValue(mockStream(chunks));

      const result = await generate(
        provider,
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'do it' }], toolCalls: [] }],
      );

      expect(result.message.toolCalls).toEqual([
        {
          type: 'function',
          id: 'call_delayed',
          name: 'foo',
          arguments: '{"a":1}',
        },
      ]);
    });

    it('marks sequential indexed tool calls ready at merge boundaries', async () => {
      const provider = createProvider(true);

      const chunks = [
        makeChunk([{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '' } }]),
        makeChunk([{ index: 0, function: { arguments: '{"path":"a.txt"}' } }]),
        makeChunk([{ index: 1, id: 'call_b', function: { name: 'read_file', arguments: '' } }]),
        makeChunk([{ index: 1, function: { arguments: '{"path":"b.txt"}' } }]),
        makeChunk([], { finishReason: 'tool_calls', usage: true }),
      ];

      (
        provider as unknown as { _client: { chat: { completions: { create: unknown } } } }
      )._client.chat.completions.create = vi.fn().mockResolvedValue(mockStream(chunks));

      const events: string[] = [];
      await generate(
        provider,
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'read files' }], toolCalls: [] }],
        {
          onMessagePart(part): void {
            if (part.type === 'tool_call_part') {
              events.push(`delta:${part.index}:${part.argumentsPart}`);
            }
          },
          onToolCall(toolCall): void {
            events.push(`ready:${toolCall.id}:${toolCall.arguments ?? ''}`);
          },
        },
      );

      // onToolCall fires after stream drains, in final order.
      expect(events).toEqual([
        'delta:0:{"path":"a.txt"}',
        'delta:1:{"path":"b.txt"}',
        'ready:call_a:{"path":"a.txt"}',
        'ready:call_b:{"path":"b.txt"}',
      ]);
    });

    it('handles non-indexed tool_call delta with concrete name (emit ToolCall directly)', async () => {
      const provider = createProvider(true);

      // Some OpenAI-compatible servers emit tool_calls without an `index`
      // field. The provider must still emit a complete ToolCall with either
      // the delta's id or a generated UUID.
      const chunks = [
        {
          id: 'chatcmpl-noindex',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    // No index!
                    id: 'call_noidx',
                    function: { name: 'foo', arguments: '{"a":1}' },
                  },
                ],
              },
            },
          ],
        },
      ];

      (
        provider as unknown as { _client: { chat: { completions: { create: unknown } } } }
      )._client.chat.completions.create = vi.fn().mockResolvedValue(mockStream(chunks));

      const result = await generate(
        provider,
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'do it' }], toolCalls: [] }],
      );

      expect(result.message.toolCalls).toEqual([
        {
          type: 'function',
          id: 'call_noidx',
          name: 'foo',
          arguments: '{"a":1}',
        },
      ]);
    });

    it('handles non-indexed tool_call delta with arguments only (emit ToolCallPart)', async () => {
      const provider = createProvider(true);

      // A pure arguments-only delta without an index — no concrete name yet.
      // The provider should emit a free-standing ToolCallPart to keep the
      // generate reducer fed with argument fragments.
      const chunks = [
        {
          id: 'chatcmpl-argonly',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    function: { name: 'foo' }, // first chunk with name (no index, concrete)
                  },
                ],
              },
            },
            {
              id: 'chatcmpl-argonly',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        // no index, arguments-only
                        function: { arguments: '{"x":1}' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ];
      void chunks;
      // Single-chunk simpler test: non-indexed arg-only is a rare but real
      // wire shape from some OpenAI-compatible servers.
      const singleChunk = {
        id: 'chatcmpl-argonly',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ function: { arguments: '{"x":1}' } }],
            },
          },
        ],
      };

      (
        provider as unknown as { _client: { chat: { completions: { create: unknown } } } }
      )._client.chat.completions.create = vi.fn().mockResolvedValue(mockStream([singleChunk]));

      // generate() uses the reducer which expects a ToolCall header before
      // accumulating arguments. A pure arg-only without a prior header is
      // dropped as "orphan", so verify the raw stream yield instead.
      const stream = await provider.generate('', [], []);
      const parts: Array<Record<string, unknown>> = [];
      for await (const p of stream) {
        parts.push(p as unknown as Record<string, unknown>);
      }
      expect(parts).toEqual([{ type: 'tool_call_part', argumentsPart: '{"x":1}' }]);
    });

    it('non-stream response with tool_calls yields ToolCall parts', async () => {
      const provider = createProvider(false);
      (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue({
        id: 'chatcmpl-nonstream',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_ns_a',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":"hi"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
      );
      const parts: Array<Record<string, unknown>> = [];
      for await (const p of stream) parts.push(p as unknown as Record<string, unknown>);

      const toolCall = parts.find((p) => p['type'] === 'function');
      expect(toolCall).toMatchObject({
        type: 'function',
        id: 'call_ns_a',
        name: 'lookup',
        arguments: '{"q":"hi"}',
      });
    });

    it('non-stream response generates UUID when tool_call has no id', async () => {
      const provider = createProvider(false);
      (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue({
        id: 'chatcmpl-uuid',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
          },
        ],
      });

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
      );
      const parts: Array<Record<string, unknown>> = [];
      for await (const p of stream) parts.push(p as unknown as Record<string, unknown>);

      const toolCall = parts.find((p) => p['type'] === 'function');
      expect(toolCall).toMatchObject({
        type: 'function',
        id: expect.stringMatching(/.+/),
      });
    });
  });

  describe('provider property accessors', () => {
    it('modelParameters returns combined config', () => {
      const provider = createProvider().withGenerationKwargs({ temperature: 0.5 });
      const params = provider.modelParameters;
      expect(params).toMatchObject({
        model: 'kimi-k2-turbo-preview',
        temperature: 0.5,
        baseUrl: expect.any(String),
      });
    });
  });

  describe('withThinking medium', () => {
    it('maps medium -> thinking.effort=medium for an effort-capable model', () => {
      const provider = createProvider(false, ['low', 'medium', 'high']).withThinking('medium');
      expect(provider.thinkingEffort).toBe('medium');
    });
  });

  describe('withExtraBody', () => {
    it('forwards thinking.keep verbatim, hoisted to the request top level', async () => {
      const provider = createProvider().withExtraBody({ thinking: { keep: 'all' } });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['thinking']).toEqual({ keep: 'all' });
      expect(body['extra_body']).toBeUndefined();
    });

    it('field-merges thinking when called after withThinking', async () => {
      const provider = createProvider(false, ['low', 'high', 'max'])
        .withThinking('high')
        .withExtraBody({ thinking: { keep: 'all' } });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['thinking']).toEqual({ type: 'enabled', effort: 'high', keep: 'all' });
      expect(body['extra_body']).toBeUndefined();
    });

    it('uses last-writer-wins for top-level keys other than thinking', () => {
      const provider = createProvider()
        .withExtraBody({ foo: 1, thinking: { type: 'enabled' } })
        .withExtraBody({ foo: 2 });

      expect(getGenerationState(provider).extra_body).toEqual({
        foo: 2,
        thinking: { type: 'enabled' },
      });
    });

    it('merges thinking when withExtraBody runs before withThinking', () => {
      const provider = createProvider()
        .withExtraBody({ thinking: { keep: 'all' } })
        .withThinking('high');

      expect(getGenerationState(provider).extra_body).toEqual({
        thinking: { type: 'enabled', effort: 'high', keep: 'all' },
      });
    });

    it('does not block subsequent withThinking when seeded with an empty thinking patch', async () => {
      const provider = createProvider()
        .withExtraBody({ thinking: {} })
        .withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['thinking']).toEqual({ type: 'enabled', effort: 'high' });
    });

    it('treats empty thinking patch as noop, preserving prior withThinking', async () => {
      const provider = createProvider().withThinking('high').withExtraBody({ thinking: {} });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['thinking']).toEqual({ type: 'enabled', effort: 'high' });
    });
  });

  describe('assistant tool call content omission', () => {
    const toolCall: ToolCall = {
      type: 'function',
      id: 'call_xyz',
      name: 'add',
      arguments: '{}',
    };

    it('omits content when assistant tool call content is empty', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add' }], toolCalls: [] },
        { role: 'assistant', content: [], toolCalls: [toolCall] },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const assistantMessage = (body['messages'] as Record<string, unknown>[])[1];

      expect(assistantMessage).toEqual({
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'call_xyz',
            function: { name: 'add', arguments: '{}' },
          },
        ],
      });
    });

    it('omits content when assistant tool call content is whitespace-only', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '   \n  ' }],
          toolCalls: [toolCall],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const assistantMessage = (body['messages'] as Record<string, unknown>[])[1];

      expect(assistantMessage).toEqual({
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'call_xyz',
            function: { name: 'add', arguments: '{}' },
          },
        ],
      });
    });

    it('keeps real assistant content alongside tool calls', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll add those." }],
          toolCalls: [toolCall],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const assistantMessage = (body['messages'] as Record<string, unknown>[])[1];

      expect(assistantMessage).toEqual({
        role: 'assistant',
        content: "I'll add those.",
        tool_calls: [
          {
            type: 'function',
            id: 'call_xyz',
            function: { name: 'add', arguments: '{}' },
          },
        ],
      });
    });

    it('keeps whitespace-only assistant content when there are no tool calls', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'assistant', content: [{ type: 'text', text: '   \n  ' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([{ role: 'assistant', content: '   \n  ' }]);
    });
  });
});

describe('extractUsageFromChunk', () => {
  it('extracts top-level usage', () => {
    const chunk = {
      id: 'test',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const usage = extractUsageFromChunk(chunk);
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('extracts choices[0].usage (Moonshot proprietary)', () => {
    const chunk = {
      id: 'chatcmpl-6970b5d02fa474c1767e8767',
      object: 'chat.completion.chunk',
      created: 1768994256,
      model: 'kimi-k2-turbo-preview',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
          usage: {
            prompt_tokens: 8,
            completion_tokens: 11,
            total_tokens: 19,
            cached_tokens: 8,
          },
        },
      ],
      system_fingerprint: 'fpv0_10a6da87',
    };

    const rawUsage = extractUsageFromChunk(chunk);
    expect(rawUsage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 11,
      total_tokens: 19,
      cached_tokens: 8,
    });

    // Also verify extractUsage converts it to TokenUsage correctly
    const tokenUsage = extractUsage(rawUsage);
    expect(tokenUsage).toEqual({
      inputOther: 0, // 8 - 8 (cached)
      output: 11,
      inputCacheRead: 8,
      inputCacheCreation: 0,
    });
  });

  it('returns null when no usage is present', () => {
    const chunk = {
      id: 'test',
      choices: [{ index: 0, delta: { content: 'hello' } }],
    };
    expect(extractUsageFromChunk(chunk)).toBeNull();
  });

  it('returns null when choices is empty', () => {
    const chunk = { id: 'test', choices: [] };
    expect(extractUsageFromChunk(chunk)).toBeNull();
  });
});

describe('extractUsage', () => {
  it('extracts basic usage', () => {
    const usage = extractUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(usage).toEqual({
      inputOther: 10,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('extracts usage with Moonshot cached_tokens', () => {
    const usage = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cached_tokens: 60,
    });
    expect(usage).toEqual({
      inputOther: 40,
      output: 20,
      inputCacheRead: 60,
      inputCacheCreation: 0,
    });
  });

  it('extracts usage with OpenAI prompt_tokens_details', () => {
    const usage = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 50 },
    });
    expect(usage).toEqual({
      inputOther: 50,
      output: 20,
      inputCacheRead: 50,
      inputCacheCreation: 0,
    });
  });

  it('returns null for null/undefined', () => {
    const undef: unknown = undefined;
    expect(extractUsage(null)).toBeNull();
    expect(extractUsage(undef)).toBeNull();
  });
});
