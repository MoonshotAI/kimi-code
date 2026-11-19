import { describe, expect, it, vi } from 'vitest';

import { anthropicProtocol, type AnthropicNativeMessage } from '#/llm/builtin/protocol/anthropic/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import {
  KIMI_DEFAULT_BASE_URL,
  kimiAnthropicRequester,
} from '#/llm/builtin/provider/kimi/index';
import { kimiAnthropicFiles, kimiFiles } from '#/llm/builtin/provider/kimi/files';
import { kimiOpenAIProtocol } from '#/llm/builtin/provider/kimi/protocol';
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  type Message,
  type StreamedMessagePart,
} from '#/llm/message';
import { sanitizeToolCallId } from '#/llm/protocol/kit/ids';
import type { Pattern } from '#/llm/protocol/pattern';
import type { LlmRequestModel, LlmRequestProfile, ModelCapability } from '#/llm/request';
import { contentsOf, createRequester } from '#/llm/requester';

import { asyncChunks, runGenerate, sseResponse, TEST_MODEL, testModule } from './harness';

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

function moduleWith<TOptions = never>(input: {
  readonly model?: LlmRequestModel;
  readonly profile?: LlmRequestProfile;
  readonly messages?: readonly Message[];
  readonly usedTokens?: number;
  readonly options?: TOptions;
} = {}) {
  return testModule<TOptions>({
    model: input.model ?? TEST_MODEL,
    profile: input.profile,
    messages: input.messages ?? [createUserMessage('hi')],
    usedTokens: input.usedTokens,
    options: input.options,
  });
}

const chatChunks = [{
  id: 'chatcmpl-1',
  choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
}];

const toolHistory = [
  createUserMessage('hi'),
  createAssistantMessage([], [
    { type: 'function', id: 'call|abc', name: 'get_weather', arguments: '{}' },
  ]),
  createToolMessage('call|abc', 'sunny'),
];

describe('request headers', () => {
  it('sends model defaultHeaders on openai requests', async () => {
    let seen: Request | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen = new Request(input, init);
      return sseResponse(chatChunks);
    };
    await runGenerate(openAIProtocol, {
      module: moduleWith(),
      endpoint: {
        baseUrl: 'https://example.test/v1',
        headers: { 'x-model': 'b' },
        fetch,
      },
      stream: true,
    });

    expect(seen?.headers.get('x-model')).toBe('b');
  });

  it('lets model headers override the defaultHeaders hook', async () => {
    let seen: Request | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen = new Request(input, init);
      return sseResponse(chatChunks);
    };
    const requester = createRequester().with({
      protocol: { base: openAIProtocol, stream: true },
      endpoint: {
        baseUrl: 'https://example.test/v1',
        headers: { 'x-k': 'trait' },
        fetch,
      },
    });
    await requester.generate({
      model: TEST_MODEL,
      content: { messages: [createUserMessage('hi')] },
      endpoint: { headers: { 'x-k': 'model' } },
      policy: { retry: { maxAttemptsPerStep: 1 } },
    }, { signal: new AbortController().signal });

    expect(seen?.headers.get('x-k')).toBe('model');
  });
});

describe('capability traits', () => {
  it('resolves capabilities from the base prefixes and the variant hook', () => {
    expect(openAIProtocol.capability?.('o1')).toMatchObject({ thinking: true, tool_use: true, image_in: false });
    expect(openAIProtocol.capability?.('gpt-4o')).toMatchObject({ image_in: true, thinking: false });
    expect(openAIProtocol.capability?.('gpt-3.5-turbo')).toMatchObject({ tool_use: true, image_in: false, thinking: false });
    expect(openAIProtocol.capability?.('no-such-model')).toBeUndefined();
    expect(anthropicProtocol.capability?.('claude-sonnet-4-20250514')).toMatchObject({ thinking: true, image_in: true });
    expect(anthropicProtocol.capability?.('claude-3-haiku')).toMatchObject({ image_in: true, thinking: false });
    expect(anthropicProtocol.capability?.('no-such-model')).toBeUndefined();

    const capability: ModelCapability = {
      image_in: true,
      video_in: true,
      audio_in: true,
      thinking: true,
      tool_use: true,
    };
    expect(openAIProtocol.with({ capability: () => capability }).capability?.('o1')).toBe(capability);
  });
});

describe('Kimi media traits', () => {
  it('rejects a non-video mime type', async () => {
    await expect(kimiFiles.upload(
      { data: new Uint8Array([1]), kind: 'video', mimeType: 'image/png' },
      { endpoint: {}, signal: new AbortController().signal },
    )).rejects.toThrow('Expected a video mime type');
  });

  it('returns the server error when a video upload has no api key', async () => {
    const urls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new Request(input, init).url;
      if (url === 'data:,') return new Response();
      urls.push(url);
      return Response.json({
        error: { message: 'video key rejected by server', code: 'invalid_api_key' },
      }, { status: 401 });
    });
    await expect(kimiFiles.upload(
      { data: new Uint8Array([1]), kind: 'video', mimeType: 'video/mp4' },
      { endpoint: { baseUrl: 'https://example.test/v1', fetch }, signal: new AbortController().signal },
    )).rejects.toMatchObject({
      status: 401,
      error: { message: 'video key rejected by server', code: 'invalid_api_key' },
    });
    expect(urls).toEqual(['https://example.test/v1/files']);
  });

  it('returns the server error when an image upload has no api key', async () => {
    const urls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new Request(input, init).url;
      if (url === 'data:,') return new Response();
      urls.push(url);
      return Response.json({
        error: { message: 'image key rejected by server', code: 'invalid_api_key' },
      }, { status: 401 });
    });
    await expect(kimiFiles.upload(
      { data: new Uint8Array([1]), kind: 'image', mimeType: 'image/png' },
      { endpoint: { baseUrl: 'https://example.test/v1', fetch }, signal: new AbortController().signal },
    )).rejects.toMatchObject({
      status: 401,
      error: { message: 'image key rejected by server', code: 'invalid_api_key' },
    });
    expect(urls).toEqual(['https://example.test/v1/files']);
  });

  it('restores the stripped /v1 for anthropic-routed kimi models', async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new Request(input, init).url;
      if (url === 'data:,') return new Response();
      urls.push(url);
      return Response.json({ id: `image-${urls.length}`, status: 'ready' });
    };
    for (const baseUrl of [
      'https://api.example.test',
      'https://api.example.test/v1',
      'https://api.example.test/',
    ]) {
      await kimiAnthropicFiles.upload(
        { data: new Uint8Array([1]), kind: 'image', mimeType: 'image/png' },
        { endpoint: { baseUrl, apiKey: 'test-key', fetch }, signal: new AbortController().signal },
      );
    }
    await kimiFiles.upload(
      { data: new Uint8Array([1]), kind: 'image', mimeType: 'image/png' },
      {
        endpoint: { baseUrl: 'https://api.example.test', apiKey: 'test-key', fetch },
        signal: new AbortController().signal,
      },
    );

    expect(urls).toEqual([
      'https://api.example.test/v1/files',
      'https://api.example.test/v1/files',
      'https://api.example.test/v1/files',
      'https://api.example.test/files',
    ]);
    expect(contentsOf(kimiAnthropicRequester).endpoint?.defaultBaseUrl).toBe(KIMI_DEFAULT_BASE_URL);
  });
});

describe('endpoint and tool traits', () => {
  it('normalizes tool schemas for kimi', () => {
    const request = kimiOpenAIProtocol.encode(moduleWith({
      profile: {
        tools: [{
          name: 'weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: { unit: { enum: ['celsius', 'fahrenheit'] } },
          },
        }],
      },
    }));
    const tools = records(record(request.params)['tools']);
    const parameters = record(record(record(tools[0])['function'])['parameters']);
    expect(record(record(parameters['properties'])['unit'])['type']).toBe('string');
  });

  it('drops tool-declaration-only system messages without the kimi protocol', () => {
    const messages: readonly Message[] = [{
      role: 'system',
      content: [],
      tools: [{ name: 'weather', description: 'Get weather', parameters: { type: 'object' } }],
    }, createUserMessage('hi')];
    const request = openAIProtocol.encode(moduleWith({ messages }));
    expect(record(request.params)['messages']).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('uses max_tokens for other models on the plain openai requester', () => {
    const request = openAIProtocol.encode(moduleWith({
      model: {
        ...TEST_MODEL,
        spec: { ...TEST_MODEL.spec, name: 'gpt-4o' },
        maxOutputTokens: 1000,
      },
    }));
    expect(record(request.params)['max_tokens']).toBe(1000);
    expect(record(request.params)['max_completion_tokens']).toBeUndefined();
  });
});

describe('protocol patches and pipeline', () => {
  it('lets a protocol patch reshape the final params', () => {
    const protocol = openAIProtocol.with({
      finalize: (native) => ({ ...native, params: { ...native.params, x_custom: 1 } }),
    });
    expect(record(protocol.encode(moduleWith()).params)['x_custom']).toBe(1);
  });

  it('lets a protocol patch override the policy', () => {
    const protocol = openAIProtocol.with({
      toolCallId: { normalize: (id) => sanitizeToolCallId(id, 4), maxLength: 4 },
    });
    const messages = [
      createUserMessage('hi'),
      createAssistantMessage([], [
        { type: 'function', id: 'call_abcdef', name: 'f', arguments: null },
      ]),
    ];
    const request = protocol.encode(moduleWith({ messages }));
    const bodyMessages = records(record(request.params)['messages']);
    expect(records(bodyMessages[1]?.['tool_calls'])[0]?.['id']).toBe('call');
  });

  it('resolves and recovers the whole request before protocol history merging', async () => {
    let attempts = 0;
    const bodies: Record<string, unknown>[] = [];
    const seen: string[] = [];
    const recoverySeen: string[] = [];
    const protocol = openAIProtocol.with({
      finalize: (native) => ({
        ...native,
        messages: [...native.messages, { role: 'user', content: 'extra' }],
      }),
      sendStream: async (_client, request) => {
        attempts += 1;
        if (attempts === 1) throw new Error('recover');
        bodies.push(record(request.params));
        return { body: asyncChunks(chatChunks) };
      },
    });
    const { outcome } = await runGenerate(protocol, {
      module: moduleWith({
        model: { ...TEST_MODEL, spec: { ...TEST_MODEL.spec, name: 'gpt-4o' } },
        profile: {
          systemPrompt: 'sys',
          tools: [{ name: 'original', description: 'original tool', parameters: {} }],
        },
      }),
      recoveries: [
        {
          propose: () => ({ strategy: 'noop', action: 'noop', rewrite: (request) => request }),
        },
        {
          propose: (ctx) => {
            recoverySeen.push(`${ctx.request.profile?.systemPrompt ?? ''}:${ctx.request.model.spec.name}`);
            return {
              strategy: 'request',
              action: 'rewrite',
              rewrite: (request) => ({
                ...request,
                model: { ...request.model, maxOutputTokens: 321 },
                profile: { ...request.profile, systemPrompt: 'recovered' },
              }),
            };
          },
        },
      ],
      resolvers: [
        {
          id: 'whole-request',
          recoveryRequest: 'resolved',
          resolve: (request) => {
            seen.push(request.profile?.systemPrompt ?? '');
            return Promise.resolve({
              ...request,
              model: {
                ...request.model,
                spec: { ...request.model.spec, name: 'resolved-model' },
                sampling: { temperature: 0.25 },
              },
              profile: { ...request.profile, systemPrompt: 'resolved' },
              content: { ...request.content, messages: [createUserMessage('resolved message')] },
            });
          },
        },
        {
          id: 'chained',
          resolve: (request, ctl) => {
            seen.push(`${request.profile?.systemPrompt ?? ''}:${request.model.spec.name}:${ctl.signal.aborted}:${ctl.appliedRecoveries.map((recovery) => `${recovery.strategy}/${recovery.action}`).join(',')}`);
            ctl.report({ code: 'resolver.chained', message: 'chained' });
            return Promise.resolve({
              ...request,
              profile: {
                ...request.profile,
                systemPrompt: 'chained',
                tools: [
                  { name: 'resolved', description: 'resolved tool', parameters: {} },
                  { name: 'deferred', description: 'deferred tool', parameters: {}, deferred: true },
                ],
              },
            });
          },
        },
      ],
    });

    expect(outcome.type).toBe('done');
    expect(attempts).toBe(2);
    expect(recoverySeen).toEqual(['resolved:resolved-model']);
    expect(seen).toEqual([
      'sys',
      'resolved:resolved-model:false:',
      'recovered',
      'resolved:resolved-model:false:request/rewrite',
    ]);
    expect(bodies[0]).toMatchObject({ model: 'resolved-model', temperature: 0.25, max_tokens: 321 });
    expect(bodies[0]?.['messages']).toEqual([
      { role: 'system', content: 'chained' },
      { role: 'user', content: 'resolved message' },
      { role: 'user', content: 'extra' },
    ]);
  });

  it('composes the pipeline stages in a fixed order', () => {
    const order: string[] = [];
    let historySeenByMerge: readonly unknown[] | undefined;
    let systemSeen: string | undefined;
    const protocol = openAIProtocol.with((base) => ({
      cacheKey: (key) => {
        order.push('cacheKey');
        return base.cacheKey?.(key) ?? {};
      },
      thinking: (thinking, module) => {
        order.push('thinking');
        return base.thinking(thinking, module);
      },
      message: (message, module) => {
        order.push(`message:${message.role}`);
        return base.message(message, module);
      },
      tool: (tool) => {
        order.push('tool');
        return base.tool(tool);
      },
      mergeTurns: [{
        name: 'probeMergeTurns',
        rewrite: (items, index) => {
          if (index === 0) {
            order.push('mergeTurns');
            historySeenByMerge = items;
          }
          return null;
        },
      }],
      finalize: (native) => {
        order.push('finalize');
        systemSeen = native.system;
        return native;
      },
    }));
    const request = protocol.encode(moduleWith({
      model: { ...TEST_MODEL, cacheKey: 'cache-1', thinking: { effort: 'high' } },
      profile: {
        systemPrompt: 'sys',
        tools: [{ name: 'weather', description: 'Get weather', parameters: { type: 'object' } }],
      },
    }));

    expect(order).toEqual(['cacheKey', 'thinking', 'message:user', 'tool', 'mergeTurns', 'finalize']);
    expect(record(request.params)['prompt_cache_key']).toBe('cache-1');
    expect(record(request.params)['reasoning_effort']).toBe('high');
    expect(systemSeen).toBe('sys');
    expect(historySeenByMerge?.[0]).toEqual({ role: 'user', content: 'hi' });
    expect(records(record(request.params)['messages'])[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('lets protocol patches reshape messages, history, and tools', () => {
    const appendExtra: Pattern<AnthropicNativeMessage> = {
      name: 'appendExtra',
      rewrite(items, index) {
        if (index !== items.length - 1) return null;
        const last = items[index];
        if (last === undefined) return null;
        return {
          consumed: 1,
          replacement: [last, { role: 'user', content: [{ type: 'text', text: 'extra' }] }],
        };
      },
    };
    const protocol = anthropicProtocol.with((base) => ({
      message: (message, module) => {
        if (extractText(message) === 'drop me') return [];
        return base.message(message, module).map((native) => ({
          ...native,
          content: [
            ...(Array.isArray(native.content) ? native.content : []),
            { type: 'text', text: 'suffix' },
          ],
        }));
      },
      mergeTurns: [...(base.mergeTurns ?? []), appendExtra],
      tool: (tool) => ({
        name: `x_${tool.name}`,
        description: tool.description,
        input_schema: tool.parameters,
      }),
    }));
    const request = protocol.encode(moduleWith({
      profile: {
        tools: [{ name: 'weather', description: 'Get weather', parameters: { type: 'object' } }],
      },
      messages: [createUserMessage('hi'), createUserMessage('drop me')],
    }));
    const bodyMessages = records(record(request.params)['messages']);
    expect(bodyMessages).toHaveLength(2);
    expect(bodyMessages[0]?.['content']).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'suffix' },
    ]);
    expect(bodyMessages[1]?.['content']).toEqual([
      { type: 'text', text: 'extra', cache_control: { type: 'ephemeral' } },
    ]);
    const tools = records(record(request.params)['tools']);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.['name']).toBe('x_weather');
    expect(tools[0]?.['cache_control']).toEqual({ type: 'ephemeral' });
  });
});

describe('tool call id policies', () => {
  it('sanitizes tool call ids on the openai request and response paths', async () => {
    let body: Record<string, unknown> | undefined;
    const protocol = openAIProtocol.with({
      sendStream: async (_client, request) => {
        body = record(request.params);
        return {
          body: asyncChunks([{
            id: 'chatcmpl-1',
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call|abc',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{}' },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          }]),
        };
      },
    });
    const { events } = await runGenerate(protocol, {
      module: moduleWith({ messages: toolHistory }),
    });
    const parts: StreamedMessagePart[] = events.flatMap((event) =>
      event.type === 'llm.streaming.part' ? [event.part] : []);

    const bodyMessages = records(body?.['messages']);
    expect(records(bodyMessages[1]?.['tool_calls'])[0]?.['id']).toBe('call_abc');
    expect(bodyMessages[2]?.['tool_call_id']).toBe('call_abc');
    expect(parts.flatMap((part) => part.type === 'function' ? [[part.id, part.rawId]] : [])).toEqual([
      ['call_abc__2', 'call|abc'],
    ]);
  });

  it('sanitizes tool call ids on the anthropic request and response paths', async () => {
    let body: Record<string, unknown> | undefined;
    const protocol = anthropicProtocol.with({
      sendStream: async (_client, request) => {
        body = record(request.params);
        return {
          body: asyncChunks([
            { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 1 } } },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'call|abc', name: 'get_weather', input: {} },
            },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
            { type: 'message_stop' },
          ]),
        };
      },
    });
    const { events } = await runGenerate(protocol, {
      module: moduleWith({ messages: toolHistory }),
    });
    const parts: StreamedMessagePart[] = events.flatMap((event) =>
      event.type === 'llm.streaming.part' ? [event.part] : []);

    const blocks = records(body?.['messages']).flatMap((message) => records(message['content']));
    expect(blocks.find((block) => block['type'] === 'tool_use')?.['id']).toBe('call_abc');
    expect(blocks.find((block) => block['type'] === 'tool_result')?.['tool_use_id']).toBe('call_abc');
    expect(parts.flatMap((part) => part.type === 'function' ? [[part.id, part.rawId]] : [])).toEqual([
      ['call_abc__2', 'call|abc'],
    ]);
  });
});

describe('anthropic user message merging', () => {
  it('keeps a plain user text and a following tool result separate', () => {
    const request = anthropicProtocol.encode(moduleWith({
      messages: [createUserMessage('hi'), createToolMessage('call_1', 'sunny')],
    }));
    const messages = records(record(request.params)['messages']);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.['content']).toEqual([{ type: 'text', text: 'hi' }]);
    expect(records(messages[1]?.['content'])[0]?.['type']).toBe('tool_result');
  });

  it('merges consecutive tool result messages', () => {
    const request = anthropicProtocol.encode(moduleWith({
      messages: [createToolMessage('call_1', 'sunny'), createToolMessage('call_2', 'rainy')],
    }));
    const messages = records(record(request.params)['messages']);
    expect(messages).toHaveLength(1);
    const content = records(messages[0]?.['content']);
    expect(content).toHaveLength(2);
    expect(content.every((block) => block['type'] === 'tool_result')).toBe(true);
  });

  it('does not merge adjacent assistant messages', () => {
    const request = anthropicProtocol.encode(moduleWith({
      messages: [
        createAssistantMessage([{ type: 'text', text: 'a' }]),
        createAssistantMessage([{ type: 'text', text: 'b' }]),
      ],
    }));
    const messages = records(record(request.params)['messages']);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.['role']).toBe('assistant');
    expect(messages[1]?.['role']).toBe('assistant');
  });
});

describe('anthropic cache control', () => {
  it('marks a trailing tool result block', () => {
    const request = anthropicProtocol.encode(moduleWith({
      messages: [
        createUserMessage('hi'),
        createAssistantMessage([], [
          { type: 'function', id: 'call_1', name: 'weather', arguments: '{}' },
        ]),
        createToolMessage('call_1', 'sunny'),
      ],
    }));
    const messages = records(record(request.params)['messages']);
    const last = records(messages.at(-1)?.['content']);
    expect(last.at(-1)?.['cache_control']).toEqual({ type: 'ephemeral' });
  });
});
