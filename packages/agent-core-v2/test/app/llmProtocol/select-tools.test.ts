/**
 * select_tools progressive disclosure — kosong-side contract tests.
 *
 * Covers the three primitives this package contributes:
 *   - `Message.tools` serialization on the Kimi wire (`messages[].tools`,
 *     `{type:'function', function:{...}}` wrapping, no `content`, schema
 *     normalization and the `$` builtin branch shared with top-level tools);
 *   - `Tool.deferred` stripping in `generate()` (single strip point for every
 *     provider call — the marker itself must never reach the wire);
 *   - the `select_tools` capability bit (unknown/default-off semantics).
 */

import { UNKNOWN_CAPABILITY, isUnknownCapability } from '#/app/llmProtocol/capability';
import { catalogModelToCapability } from '#/app/llmProtocol/catalog';
import { generate } from '#/app/llmProtocol/generate';
import { isToolDeclarationOnlyMessage } from '#/app/llmProtocol/message';
import type { Message, StreamedMessagePart } from '#/app/llmProtocol/message';
import { AnthropicChatProvider } from '#/app/llmProtocol/providers/anthropic';
import { messagesToGoogleGenAIContents } from '#/app/llmProtocol/providers/google-genai';
import { KimiChatProvider } from '#/app/llmProtocol/providers/kimi';
import { OpenAILegacyChatProvider } from '#/app/llmProtocol/providers/openai-legacy';
import { OpenAIResponsesChatProvider } from '#/app/llmProtocol/providers/openai-responses';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '#/app/llmProtocol/provider';
import type { Tool } from '#/app/llmProtocol/tool';
import { describe, expect, it, vi } from 'vitest';

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

const BUILTIN_TOOL: Tool = {
  name: '$web_search',
  description: 'Search the web',
  parameters: { type: 'object', properties: {} },
};

function makeChatCompletionResponse() {
  return {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    created: 1234567890,
    model: 'kimi-test',
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

async function captureRequestBody(
  tools: Tool[],
  history: Message[],
): Promise<Record<string, unknown>> {
  const provider = new KimiChatProvider({
    model: 'kimi-test',
    apiKey: 'test-key',
    stream: false,
  });
  let capturedBody: Record<string, unknown> | undefined;
  (provider as any)._client.chat.completions.create = vi
    .fn()
    .mockImplementation((params: unknown) => {
      capturedBody = params as Record<string, unknown>;
      return Promise.resolve(makeChatCompletionResponse());
    });
  const stream = await provider.generate('system prompt', tools, history);
  for await (const part of stream) {
    void part;
  }
  if (capturedBody === undefined) {
    throw new Error('Expected provider.generate() to call chat.completions.create');
  }
  return capturedBody;
}

describe('Kimi messages[].tools serialization', () => {
  it('serializes a system message carrying tools with function wrapping and no content', async () => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'system', content: [], toolCalls: [], tools: [ADD_TOOL] },
    ];
    const body = await captureRequestBody([], history);
    const messages = body['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    const toolsMessage = messages[2]!;
    expect(toolsMessage['role']).toBe('system');
    expect('content' in toolsMessage).toBe(false);
    expect(toolsMessage['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'add',
          description: 'Add two integers.',
          parameters: ADD_TOOL.parameters,
        },
      },
    ]);
  });

  it('routes $-prefixed names through the builtin_function branch, same as top-level tools', async () => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'system', content: [], toolCalls: [], tools: [BUILTIN_TOOL] },
    ];
    const body = await captureRequestBody([], history);
    const messages = body['messages'] as Array<Record<string, unknown>>;
    expect(messages[2]!['tools']).toEqual([
      { type: 'builtin_function', function: { name: '$web_search' } },
    ]);
  });

  it('leaves messages without tools untouched (no tools key)', async () => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const body = await captureRequestBody([ADD_TOOL], history);
    const messages = body['messages'] as Array<Record<string, unknown>>;
    for (const message of messages) {
      expect('tools' in message).toBe(false);
    }
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'add',
          description: 'Add two integers.',
          parameters: ADD_TOOL.parameters,
        },
      },
    ]);
  });

  it('does not serialize the deferred marker even if a marked tool reaches convertMessage', async () => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      {
        role: 'system',
        content: [],
        toolCalls: [],
        tools: [{ ...ADD_TOOL, deferred: true }],
      },
    ];
    const body = await captureRequestBody([], history);
    const messages = body['messages'] as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(messages[2]!['tools']);
    expect(serialized).not.toContain('deferred');
  });
});

describe('generate() deferred tool stripping', () => {
  function createCapturingProvider(): { provider: ChatProvider; seenTools: () => Tool[] } {
    let captured: Tool[] = [];
    const stream: StreamedMessage = {
      id: null,
      usage: null,
      finishReason: 'completed',
      rawFinishReason: 'stop',
      async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
        yield { type: 'text', text: 'ok' };
      },
    };
    const provider: ChatProvider = {
      name: 'mock',
      modelName: 'mock-model',
      thinkingEffort: null as ThinkingEffort | null,
      generate: async (_systemPrompt, tools, _history) => {
        captured = tools;
        return stream;
      },
      withThinking(_effort: ThinkingEffort): ChatProvider {
        return this;
      },
    };
    return { provider, seenTools: () => captured };
  }

  it('strips deferred tools before the provider builds the request', async () => {
    const { provider, seenTools } = createCapturingProvider();
    await generate(provider, 'sys', [ADD_TOOL, { ...BUILTIN_TOOL, deferred: true }], [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);
    expect(seenTools()).toEqual([ADD_TOOL]);
  });

  it('passes the identical array through when nothing is deferred', async () => {
    const { provider, seenTools } = createCapturingProvider();
    const tools = [ADD_TOOL, BUILTIN_TOOL];
    await generate(provider, 'sys', tools, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);
    expect(seenTools()).toBe(tools);
  });
});

describe('providers without message-level tool declarations', () => {
  const TOOLS_ONLY_MESSAGE: Message = {
    role: 'system',
    content: [],
    toolCalls: [],
    tools: [ADD_TOOL],
  };
  const HISTORY: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    TOOLS_ONLY_MESSAGE,
  ];

  it('classifies tool-declaration-only messages', () => {
    expect(isToolDeclarationOnlyMessage(TOOLS_ONLY_MESSAGE)).toBe(true);
    expect(isToolDeclarationOnlyMessage(HISTORY[0]!)).toBe(false);
    expect(
      isToolDeclarationOnlyMessage({
        ...TOOLS_ONLY_MESSAGE,
        content: [{ type: 'text', text: 'x' }],
      }),
    ).toBe(false);
  });

  it('anthropic skips the message instead of emitting a <system></system> husk', async () => {
    const provider = new AnthropicChatProvider({ model: 'k25', apiKey: 'test-key', stream: false });
    let captured: Record<string, unknown> | undefined;
    (provider as any)._client.messages.create = vi.fn().mockImplementation((params: unknown) => {
      captured = params as Record<string, unknown>;
      return Promise.resolve({
        id: 'msg_test_123',
        type: 'message',
        role: 'assistant',
        model: 'k25',
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });
    const stream = await provider.generate('sys', [], HISTORY);
    for await (const part of stream) void part;
    expect(JSON.stringify(captured!['messages'])).not.toContain('<system>');
    expect(captured!['messages'] as unknown[]).toHaveLength(1);
  });

  it('openai chat completions skips the message instead of sending a content-free system entry', async () => {
    const provider = new OpenAILegacyChatProvider({ model: 'gpt-4.1', apiKey: 'test-key', stream: false });
    let captured: Record<string, unknown> | undefined;
    (provider as any)._client.chat.completions.create = vi
      .fn()
      .mockImplementation((params: unknown) => {
        captured = params as Record<string, unknown>;
        return Promise.resolve({
          id: 'chatcmpl-test123',
          object: 'chat.completion',
          created: 1234567890,
          model: 'gpt-4.1',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      });
    const stream = await provider.generate('sys', [], HISTORY);
    for await (const part of stream) void part;
    const messages = captured!['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message['content']).toBeDefined();
    }
  });

  it('openai responses skips the message', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-4.1', apiKey: 'test-key' });
    (provider as any)._stream = false;
    let captured: Record<string, unknown> | undefined;
    ((provider as any)._client.responses as Record<string, unknown>)['create'] = vi
      .fn()
      .mockImplementation((params: unknown) => {
        captured = params as Record<string, unknown>;
        return Promise.resolve({
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
        });
      });
    const stream = await provider.generate('sys', [], HISTORY);
    for await (const part of stream) void part;
    expect(captured!['input'] as unknown[]).toHaveLength(1);
    expect(JSON.stringify(captured!['input'])).not.toContain('"tools"');
  });

  it('google genai skips the message explicitly (not just via the empty-text coincidence)', () => {
    const contents = messagesToGoogleGenAIContents(HISTORY);
    expect(contents).toHaveLength(1);
    expect(JSON.stringify(contents)).not.toContain('<system>');
  });
});

describe('select_tools capability bit', () => {
  it('defaults to false on UNKNOWN_CAPABILITY', () => {
    expect(UNKNOWN_CAPABILITY.select_tools).toBe(false);
  });

  it('a capability that only has select_tools is not "unknown"', () => {
    expect(
      isUnknownCapability({
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: false,
        max_context_tokens: 0,
        select_tools: true,
      }),
    ).toBe(false);
  });

  it('catalog entries map select_tools and default it to false', () => {
    const base = { id: 'm', limit: { context: 1000 } };
    expect(catalogModelToCapability(base)?.capability.select_tools).toBe(false);
    expect(
      catalogModelToCapability({ ...base, select_tools: true })?.capability.select_tools,
    ).toBe(true);
  });
});
