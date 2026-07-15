/**
 * Scenario: providers receive or replay empty thinking, including Kimi histories missing the field.
 * Responsibilities: preserve explicit field/block presence and satisfy Kimi preserved-thinking wire requirements.
 * Wiring: real provider codecs with only their remote SDK clients replaced through clientFactory.
 * Run: pnpm exec vitest run packages/agent-core-v2/test/app/llmProtocol/providers/empty-thinking-roundtrip.test.ts
 */
import type { Message, StreamedMessagePart } from '#/app/llmProtocol/message';
import { AnthropicChatProvider } from '#/app/llmProtocol/providers/anthropic';
import {
  GoogleGenAIChatProvider,
  GoogleGenAIStreamedMessage,
} from '#/app/llmProtocol/providers/google-genai';
import { KimiChatProvider } from '#/app/llmProtocol/providers/kimi';
import { OpenAILegacyChatProvider } from '#/app/llmProtocol/providers/openai-legacy';
import {
  OpenAIResponsesChatProvider,
  OpenAIResponsesStreamedMessage,
} from '#/app/llmProtocol/providers/openai-responses';
import { describe, expect, it, vi } from 'vitest';

const EMPTY_THINKING_TOOL_HISTORY: Message[] = [
  {
    role: 'assistant',
    content: [{ type: 'think', think: '' }],
    toolCalls: [
      { type: 'function', id: 'call_1', name: 'lookup', arguments: '{"q":"test"}' },
    ],
  },
];

function chatCompletionResponse(message: Record<string, unknown>) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, message, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

async function collectParts(
  streamedMessage: AsyncIterable<StreamedMessagePart>,
): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of streamedMessage) parts.push(part);
  return parts;
}

async function captureKimiMessages(
  history: Message[],
  configure?: (provider: KimiChatProvider) => KimiChatProvider,
): Promise<Array<Record<string, unknown>>> {
  let captured: Record<string, unknown> | undefined;
  const create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve(chatCompletionResponse({ role: 'assistant', content: 'done' }));
  });
  let provider = new KimiChatProvider({
    model: 'kimi-k2',
    apiKey: '',
    stream: false,
    clientFactory: () => ({ chat: { completions: { create } } }) as never,
  });
  if (configure !== undefined) {
    provider = configure(provider);
  }

  const response = await provider.generate('', [], history);
  await collectParts(response);

  if (captured === undefined) {
    throw new Error('Expected Kimi provider to send a request.');
  }
  return captured['messages'] as Array<Record<string, unknown>>;
}

describe('empty thinking round-trip', () => {
  it('Kimi sends an explicitly empty ThinkPart back as reasoning_content', async () => {
    const messages = await captureKimiMessages(EMPTY_THINKING_TOOL_HISTORY);
    expect(messages[0]).toHaveProperty('reasoning_content', '');
  });

  it('Kimi backfills an assistant tool-call message when preserved thinking is active', async () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_1', name: 'lookup', arguments: '{"q":"test"}' },
        ],
      },
    ];

    const messages = await captureKimiMessages(history, (provider) =>
      provider.withExtraBody({ thinking: { type: 'enabled', keep: 'all' } }),
    );

    expect(messages[0]).toHaveProperty('reasoning_content', '');
  });

  it('Kimi backfills a text assistant message when keep=all omits thinking.type', async () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        toolCalls: [],
      },
    ];

    const messages = await captureKimiMessages(history, (provider) =>
      provider.withExtraBody({ thinking: { keep: 'all' } }),
    );

    expect(messages[0]).toHaveProperty('reasoning_content', '');
  });

  it.each([
    ['empty', ''],
    ['non-empty', 'reasoning text'],
  ])(
    'Kimi sends an existing %s ThinkPart verbatim when preserved thinking is active',
    async (_kind, think) => {
      const history: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'think', think }],
          toolCalls: [],
        },
      ];

      const messages = await captureKimiMessages(history, (provider) =>
        provider.withExtraBody({ thinking: { type: 'enabled', keep: 'all' } }),
      );

      expect(messages[0]).toHaveProperty('reasoning_content', think);
    },
  );

  it.each([
    ['missing', undefined],
    ['null', null],
    ['false', false],
    ['off', 'off'],
  ])(
    'Kimi does not backfill reasoning_content when thinking.keep is %s',
    async (_kind, keep) => {
      const history: Message[] = [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            { type: 'function', id: 'call_1', name: 'lookup', arguments: '{"q":"test"}' },
          ],
        },
      ];

      const messages = await captureKimiMessages(history, (provider) =>
        provider.withExtraBody({ thinking: { type: 'enabled', keep } }),
      );

      expect(messages[0]).not.toHaveProperty('reasoning_content');
    },
  );

  it('Kimi does not backfill reasoning_content when thinking is disabled', async () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_1', name: 'lookup', arguments: '{"q":"test"}' },
        ],
      },
    ];

    const messages = await captureKimiMessages(history, (provider) =>
      provider.withExtraBody({ thinking: { type: 'disabled', keep: 'all' } }),
    );

    expect(messages[0]).not.toHaveProperty('reasoning_content');
  });

  it('Kimi does not backfill reasoning_content on non-assistant messages', async () => {
    const history: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'System.' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: 'User.' }], toolCalls: [] },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'Tool result.' }],
        toolCalls: [],
        toolCallId: 'call_1',
      },
    ];

    const messages = await captureKimiMessages(history, (provider) =>
      provider.withExtraBody({ thinking: { type: 'enabled', keep: 'all' } }),
    );

    for (const message of messages) {
      expect(message).not.toHaveProperty('reasoning_content');
    }
  });

  it('Kimi keeps an explicitly empty response reasoning_content as a ThinkPart', async () => {
    const create = vi.fn().mockResolvedValue(
      chatCompletionResponse({
        role: 'assistant',
        content: null,
        reasoning_content: '',
      }),
    );
    const provider = new KimiChatProvider({
      model: 'kimi-k2',
      apiKey: '',
      stream: false,
      clientFactory: () => ({ chat: { completions: { create } } }) as never,
    });

    const response = await provider.generate('', [], []);

    expect(await collectParts(response)).toEqual([{ type: 'think', think: '' }]);
  });

  it('OpenAI Chat Completions sends an empty ThinkPart through the configured reasoning field', async () => {
    let captured: Record<string, unknown> | undefined;
    const create = vi.fn().mockImplementation((params: unknown) => {
      captured = params as Record<string, unknown>;
      return Promise.resolve(chatCompletionResponse({ role: 'assistant', content: 'done' }));
    });
    const provider = new OpenAILegacyChatProvider({
      model: 'compatible-reasoner',
      apiKey: '',
      stream: false,
      reasoningKey: 'reasoning_details',
      clientFactory: () => ({ chat: { completions: { create } } }) as never,
    });

    const response = await provider.generate('', [], EMPTY_THINKING_TOOL_HISTORY);
    await collectParts(response);

    const messages = captured?.['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toHaveProperty('reasoning_details', '');
  });

  it('OpenAI Chat Completions keeps an explicitly empty response reasoning field', async () => {
    const create = vi.fn().mockResolvedValue(
      chatCompletionResponse({
        role: 'assistant',
        content: null,
        reasoning_content: '',
      }),
    );
    const provider = new OpenAILegacyChatProvider({
      model: 'compatible-reasoner',
      apiKey: '',
      stream: false,
      clientFactory: () => ({ chat: { completions: { create } } }) as never,
    });

    const response = await provider.generate('', [], []);

    expect(await collectParts(response)).toEqual([{ type: 'think', think: '' }]);
  });

  it('Google GenAI sends an explicitly empty ThinkPart back as a thought part', async () => {
    let captured: Record<string, unknown> | undefined;
    const generateContent = vi.fn().mockImplementation((params: unknown) => {
      captured = params as Record<string, unknown>;
      return Promise.resolve({
        candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] } }],
      });
    });
    const provider = new GoogleGenAIChatProvider({
      model: 'gemini-3-flash',
      apiKey: '',
      stream: false,
      clientFactory: () => ({ models: { generateContent } }) as never,
    });
    const history: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'think', think: '', encrypted: 'thought-signature' }],
        toolCalls: [],
      },
    ];

    const response = await provider.generate('', [], history);
    await collectParts(response);

    const contents = captured?.['contents'] as Array<{ parts: unknown[] }>;
    expect(contents[0]!.parts[0]).toEqual({
      text: '',
      thought: true,
      thoughtSignature: 'thought-signature',
    });
  });

  it('Google GenAI keeps an explicitly empty response thought part', async () => {
    const response = new GoogleGenAIStreamedMessage(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: '', thought: true, thoughtSignature: 'thought-signature' }],
            },
          },
        ],
      },
      false,
    );

    expect(await collectParts(response)).toEqual([
      { type: 'think', think: '', encrypted: 'thought-signature' },
    ]);
  });

  it('Anthropic-compatible providers send unsigned empty thinking blocks back', async () => {
    let captured: Record<string, unknown> | undefined;
    const create = vi.fn().mockImplementation((params: unknown) => {
      captured = params as Record<string, unknown>;
      return Promise.resolve({
        id: 'msg_test',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const provider = new AnthropicChatProvider({
      model: 'compatible-model',
      apiKey: '',
      defaultMaxTokens: 1024,
      stream: false,
      clientFactory: () => ({ messages: { create } }) as never,
    });

    const response = await provider.generate('', [], EMPTY_THINKING_TOOL_HISTORY);
    await collectParts(response);

    const messages = captured?.['messages'] as Array<{ content: unknown[] }>;
    expect(messages[0]!.content[0]).toEqual({ type: 'thinking', thinking: '' });
  });

  it('OpenAI Responses sends an explicitly empty ThinkPart as a reasoning item', async () => {
    let captured: Record<string, unknown> | undefined;
    async function* responseStream() {
      yield { type: 'response.output_text.delta', delta: 'done' };
      yield {
        type: 'response.completed',
        response: { id: 'resp_test', usage: { input_tokens: 1, output_tokens: 1 } },
      };
    }
    const create = vi.fn().mockImplementation((params: unknown) => {
      captured = params as Record<string, unknown>;
      return Promise.resolve(responseStream());
    });
    const provider = new OpenAIResponsesChatProvider({
      model: 'gpt-5',
      apiKey: '',
      clientFactory: () => ({ responses: { create } }) as never,
    });

    const response = await provider.generate('', [], EMPTY_THINKING_TOOL_HISTORY);
    await collectParts(response);

    const input = captured?.['input'] as Array<Record<string, unknown>>;
    expect(input.find((item) => item['type'] === 'reasoning')).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '' }],
    });
  });

  it('OpenAI Responses keeps a non-stream reasoning item with no summaries', async () => {
    const response = new OpenAIResponsesStreamedMessage(
      {
        id: 'resp_test',
        status: 'completed',
        output: [{ type: 'reasoning', encrypted_content: 'enc_empty', summary: [] }],
      },
      false,
    );

    expect(await collectParts(response)).toEqual([
      { type: 'think', think: '', encrypted: 'enc_empty' },
    ]);
  });
});
