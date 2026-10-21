import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStaticCredentialProvider } from '#human/credentials/credentials';
import type { LlmModel } from '#human/llm/model';
import type {
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequestControl,
  LlmRequestEvent,
  LlmRequester,
} from '#human/llm/requester/requester';
import type { Message, Tool } from '#/llm-adapter/contract/message';
import type { Model } from '#/llm-adapter/model/catalog';
import type { ModelRequestEvent } from '#/llm-adapter/model/model-requester';
import {
  ModelRequesterImpl,
  type ModelLlmGateway,
  type ModelRequesterObservability,
} from '#/llm-adapter/model/model-requester-impl';
import {
  EMPTY_TOOL_OUTPUT_PLACEHOLDER,
  OMITTED_TOOL_AUDIO_PLACEHOLDER,
  OMITTED_TOOL_VIDEO_PLACEHOLDER,
  REQUEST_SANITIZE_ENV,
  resolveRequestSanitizeEnabled,
  sanitizeRequestMessages,
  sanitizeRequestSurface,
  type RequestSanitizeRepair,
} from '#/llm-adapter/model/requestSanitize';

const LONE_LEAD = '\uD83D';
const LONE_TRAIL = '\uDE00';
const VALID_PAIR = '\uD83D\uDE00';
const EMOJI = '\u{1F44B}';
const REPLACEMENT = '\uFFFD';

function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function toolMessage(content: Message['content']): Message {
  return { role: 'tool', content, toolCalls: [], toolCallId: 'call-1' };
}

function repairsOfKind(
  repairs: readonly RequestSanitizeRepair[],
  kind: RequestSanitizeRepair['kind'],
) {
  return repairs.filter((repair) => repair.kind === kind);
}

describe('sanitizeRequestMessages lone surrogates', () => {
  it('replaces a lone lead surrogate in text content with U+FFFD', () => {
    const { messages, repairs } = sanitizeRequestMessages([userText(`abc${LONE_LEAD}def`)]);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: `abc${REPLACEMENT}def` }]);
    expect(repairsOfKind(repairs, 'lone_surrogate')).toEqual([
      { kind: 'lone_surrogate', role: 'user', count: 1 },
    ]);
  });

  it('replaces a lone trail surrogate in text content with U+FFFD', () => {
    const { messages, repairs } = sanitizeRequestMessages([userText(`abc${LONE_TRAIL}`)]);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: `abc${REPLACEMENT}` }]);
    expect(repairsOfKind(repairs, 'lone_surrogate')).toHaveLength(1);
  });

  it('replaces a lead surrogate left dangling before a non-trail code unit', () => {
    const { messages } = sanitizeRequestMessages([userText(`x${LONE_LEAD}y`)]);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: `x${REPLACEMENT}y` }]);
  });

  it('keeps valid surrogate pairs and emoji untouched', () => {
    const input = [userText(`smile ${VALID_PAIR} wave ${EMOJI}`)];
    const { messages, repairs } = sanitizeRequestMessages(input);
    expect(messages[0]).toBe(input[0]);
    expect(repairs).toEqual([]);
  });

  it('counts every replaced code unit in a message', () => {
    const { repairs } = sanitizeRequestMessages([userText(`${LONE_TRAIL}${LONE_TRAIL}${LONE_LEAD}`)]);
    expect(repairsOfKind(repairs, 'lone_surrogate')).toEqual([
      { kind: 'lone_surrogate', role: 'user', count: 3 },
    ]);
  });

  it('sanitizes think parts', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'think', think: `plan${LONE_TRAIL}` }],
      toolCalls: [],
    };
    const { messages, repairs } = sanitizeRequestMessages([message]);
    expect(messages[0]?.content).toEqual([{ type: 'think', think: `plan${REPLACEMENT}` }]);
    expect(repairsOfKind(repairs, 'lone_surrogate')).toEqual([
      { kind: 'lone_surrogate', role: 'assistant', count: 1 },
    ]);
  });

  it('sanitizes tool call names and arguments', () => {
    const message: Message = {
      role: 'assistant',
      content: [],
      toolCalls: [
        { type: 'function', id: 'c1', name: `run${LONE_LEAD}`, arguments: `{"path":"a${LONE_TRAIL}"}` },
      ],
    };
    const { messages, repairs } = sanitizeRequestMessages([message]);
    expect(messages[0]?.toolCalls).toEqual([
      { type: 'function', id: 'c1', name: 'run\uFFFD', arguments: '{"path":"a\uFFFD"}' },
    ]);
    expect(repairsOfKind(repairs, 'lone_surrogate')).toEqual([
      { kind: 'lone_surrogate', role: 'assistant', count: 2 },
    ]);
  });

  it('sanitizes nested strings inside tool call extras and declared tool parameters', () => {
    const message: Message = {
      role: 'system',
      content: [],
      toolCalls: [
        {
          type: 'function',
          id: 'c1',
          name: 'run',
          arguments: null,
          extras: { note: [`x${LONE_LEAD}`] },
        },
      ],
      tools: [
        {
          name: 't',
          description: 'd',
          parameters: { properties: { p: { description: `deep${LONE_TRAIL}` } } },
        },
      ],
    };
    const { messages, repairs } = sanitizeRequestMessages([message]);
    expect(messages[0]?.toolCalls[0]?.extras).toEqual({ note: [`x${REPLACEMENT}`] });
    expect(messages[0]?.tools?.[0]?.parameters).toEqual({
      properties: { p: { description: `deep${REPLACEMENT}` } },
    });
    expect(repairsOfKind(repairs, 'lone_surrogate')).toEqual([
      { kind: 'lone_surrogate', role: 'system', count: 2 },
    ]);
  });

  it('does not mutate the input messages', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: `a${LONE_LEAD}` }],
      toolCalls: [{ type: 'function', id: 'c1', name: 't', arguments: LONE_TRAIL }],
    };
    sanitizeRequestMessages([message]);
    expect(message.content[0]).toEqual({ type: 'text', text: `a${LONE_LEAD}` });
    expect(message.toolCalls[0]?.arguments).toBe(LONE_TRAIL);
  });
});

describe('sanitizeRequestMessages empty tool content', () => {
  it('pads a tool message whose content array is empty', () => {
    const { messages, repairs } = sanitizeRequestMessages([toolMessage([])]);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: EMPTY_TOOL_OUTPUT_PLACEHOLDER }]);
    expect(repairsOfKind(repairs, 'empty_tool_content')).toEqual([
      { kind: 'empty_tool_content', role: 'tool', toolCallId: 'call-1', count: 1 },
    ]);
  });

  it('pads a tool message whose text parts are all empty', () => {
    const { messages, repairs } = sanitizeRequestMessages([
      toolMessage([
        { type: 'text', text: '' },
        { type: 'text', text: '' },
      ]),
    ]);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: EMPTY_TOOL_OUTPUT_PLACEHOLDER }]);
    expect(repairsOfKind(repairs, 'empty_tool_content')).toHaveLength(1);
  });

  it('pads a tool message carrying only think parts', () => {
    const { messages, repairs } = sanitizeRequestMessages([
      toolMessage([{ type: 'think', think: 'irrelevant' }]),
    ]);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: EMPTY_TOOL_OUTPUT_PLACEHOLDER }]);
    expect(repairsOfKind(repairs, 'empty_tool_content')).toHaveLength(1);
  });

  it('pads a tool message carrying only an audio part on the anthropic protocol', () => {
    const { messages, repairs } = sanitizeRequestMessages(
      [toolMessage([{ type: 'audio_url', audioUrl: { url: 'https://cdn.example.test/a.mp3' } }])],
      { protocol: 'anthropic' },
    );
    expect(messages[0]?.content).toEqual([{ type: 'text', text: EMPTY_TOOL_OUTPUT_PLACEHOLDER }]);
    expect(repairsOfKind(repairs, 'empty_tool_content')).toHaveLength(1);
  });

  it('keeps a tool message with non-empty text untouched', () => {
    const input = [toolMessage([{ type: 'text', text: 'ok' }])];
    const { messages, repairs } = sanitizeRequestMessages(input, { protocol: 'anthropic' });
    expect(messages[0]).toBe(input[0]);
    expect(repairs).toEqual([]);
  });

  it('does not pad non-tool messages with empty content', () => {
    const input: Message[] = [
      { role: 'assistant', content: [], toolCalls: [] },
      { role: 'user', content: [], toolCalls: [] },
    ];
    const { messages, repairs } = sanitizeRequestMessages(input, { protocol: 'anthropic' });
    expect(messages[0]).toBe(input[0]);
    expect(messages[1]).toBe(input[1]);
    expect(repairs).toEqual([]);
  });
});

describe('sanitizeRequestMessages unsupported tool media', () => {
  const dataVideo = { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } } as const;
  const dataAudio = { type: 'audio_url', audioUrl: { url: 'data:audio/mpeg;base64,AAAA' } } as const;
  const hostedVideo = {
    type: 'video_url',
    videoUrl: { url: 'https://cdn.example.test/v.mp4' },
  } as const;

  it('downgrades a base64 video part in a tool message on the anthropic protocol', () => {
    const { messages, repairs } = sanitizeRequestMessages(
      [toolMessage([{ type: 'text', text: 'frames' }, dataVideo])],
      { protocol: 'anthropic' },
    );
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'frames' },
      { type: 'text', text: OMITTED_TOOL_VIDEO_PLACEHOLDER },
    ]);
    expect(repairsOfKind(repairs, 'unsupported_tool_media')).toEqual([
      { kind: 'unsupported_tool_media', role: 'tool', toolCallId: 'call-1', count: 1 },
    ]);
  });

  it('downgrades a base64 audio part in a tool message on the anthropic protocol', () => {
    const { messages } = sanitizeRequestMessages(
      [toolMessage([{ type: 'text', text: 'clip' }, dataAudio])],
      { protocol: 'anthropic' },
    );
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'clip' },
      { type: 'text', text: OMITTED_TOOL_AUDIO_PLACEHOLDER },
    ]);
  });

  it('lets the downgraded placeholder stand as the only content', () => {
    const { messages, repairs } = sanitizeRequestMessages([toolMessage([dataVideo])], {
      protocol: 'anthropic',
    });
    expect(messages[0]?.content).toEqual([{ type: 'text', text: OMITTED_TOOL_VIDEO_PLACEHOLDER }]);
    expect(repairsOfKind(repairs, 'unsupported_tool_media')).toHaveLength(1);
    expect(repairsOfKind(repairs, 'empty_tool_content')).toHaveLength(0);
  });

  it('keeps url-based video parts on the anthropic protocol', () => {
    const input = [toolMessage([hostedVideo])];
    const { messages, repairs } = sanitizeRequestMessages(input, { protocol: 'anthropic' });
    expect(messages[0]).toBe(input[0]);
    expect(repairs).toEqual([]);
  });

  it('keeps base64 video parts on the openai protocol', () => {
    const input = [toolMessage([dataVideo])];
    const { messages, repairs } = sanitizeRequestMessages(input, { protocol: 'openai' });
    expect(messages[0]).toBe(input[0]);
    expect(repairs).toEqual([]);
  });

  it('downgrades base64 video parts when no protocol signal is available', () => {
    const { messages, repairs } = sanitizeRequestMessages([toolMessage([dataVideo])]);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: OMITTED_TOOL_VIDEO_PLACEHOLDER }]);
    expect(repairsOfKind(repairs, 'unsupported_tool_media')).toHaveLength(1);
  });
});

describe('sanitizeRequestMessages identity', () => {
  it('returns the input array untouched when nothing needs repair', () => {
    const input: Message[] = [userText('hello'), toolMessage([{ type: 'text', text: 'result' }])];
    const { messages, repairs } = sanitizeRequestMessages(input, { protocol: 'anthropic' });
    expect(messages).toBe(input);
    expect(repairs).toEqual([]);
  });
});

describe('sanitizeRequestMessages tool call id stability', () => {
  const leadId = `abc${LONE_LEAD}`;
  const trailId = `abc${LONE_TRAIL}`;

  function poisonedExchange(): Message[] {
    return [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: leadId, name: 'read', arguments: '{}' },
          { type: 'function', id: trailId, name: 'read', arguments: '{}' },
        ],
      },
      { role: 'tool', content: [{ type: 'text', text: 'r1' }], toolCalls: [], toolCallId: leadId },
      { role: 'tool', content: [{ type: 'text', text: 'r2' }], toolCalls: [], toolCallId: trailId },
    ];
  }

  it('keeps ids that differ only by lone surrogates distinct', () => {
    const { messages } = sanitizeRequestMessages(poisonedExchange());
    const calls = messages[0]?.toolCalls ?? [];
    expect(calls[0]?.id).toBe(`abc${REPLACEMENT}`);
    expect(calls[1]?.id).toBe(`abc${REPLACEMENT}__2`);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
  });

  it('maps the same raw id to the same new id on both sides of the pairing', () => {
    const { messages } = sanitizeRequestMessages(poisonedExchange());
    expect(messages[1]?.toolCallId).toBe(messages[0]?.toolCalls[0]?.id);
    expect(messages[2]?.toolCallId).toBe(messages[0]?.toolCalls[1]?.id);
  });

  it('gives later duplicates a stable ascending suffix', () => {
    const thirdId = `abc${String.fromCodePoint(0xdbff)}`;
    const input: Message[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: leadId, name: 'read', arguments: '{}' },
          { type: 'function', id: trailId, name: 'read', arguments: '{}' },
          { type: 'function', id: thirdId, name: 'read', arguments: '{}' },
        ],
      },
    ];
    const first = sanitizeRequestMessages(input);
    const second = sanitizeRequestMessages(input);
    expect(first.messages[0]?.toolCalls.map((call) => call.id)).toEqual([
      `abc${REPLACEMENT}`,
      `abc${REPLACEMENT}__2`,
      `abc${REPLACEMENT}__3`,
    ]);
    expect(second.messages[0]?.toolCalls.map((call) => call.id)).toEqual(
      first.messages[0]?.toolCalls.map((call) => call.id),
    );
  });

  it('keeps clean distinct ids free of suffixes', () => {
    const input: Message[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call-1', name: 'read', arguments: '{}' },
          { type: 'function', id: 'call-2', name: 'read', arguments: '{}' },
        ],
      },
      { role: 'tool', content: [{ type: 'text', text: 'r1' }], toolCalls: [], toolCallId: 'call-1' },
    ];
    const { messages, repairs } = sanitizeRequestMessages(input);
    expect(messages[0]?.toolCalls.map((call) => call.id)).toEqual(['call-1', 'call-2']);
    expect(messages[1]?.toolCallId).toBe('call-1');
    expect(messages[0]).toBe(input[0]);
    expect(messages[1]).toBe(input[1]);
    expect(repairs).toEqual([]);
  });

  it('counts the surrogates inside remapped ids toward the message repair tally', () => {
    const { repairs } = sanitizeRequestMessages(poisonedExchange());
    expect(repairsOfKind(repairs, 'lone_surrogate')).toEqual([
      { kind: 'lone_surrogate', role: 'assistant', count: 2 },
      { kind: 'lone_surrogate', role: 'tool', toolCallId: `abc${REPLACEMENT}`, count: 1 },
      { kind: 'lone_surrogate', role: 'tool', toolCallId: `abc${REPLACEMENT}__2`, count: 1 },
    ]);
  });

  it('records the repaired ids in the repair log signature surfaces', () => {
    const { repairs } = sanitizeRequestMessages([
      { role: 'tool', content: [], toolCalls: [], toolCallId: leadId },
    ]);
    expect(repairsOfKind(repairs, 'empty_tool_content')).toEqual([
      { kind: 'empty_tool_content', role: 'tool', toolCallId: `abc${REPLACEMENT}`, count: 1 },
    ]);
  });
});

describe('sanitizeRequestSurface', () => {
  it('repairs lone surrogates in request-level tool name, description and parameters', () => {
    const tools: Tool[] = [
      {
        name: `read${LONE_LEAD}`,
        description: `reads${LONE_TRAIL}`,
        parameters: { properties: { path: { description: `p${LONE_LEAD}` } } },
      },
    ];
    const { tools: sanitized, repairs } = sanitizeRequestSurface('sys', tools);
    expect(sanitized).toEqual([
      {
        name: `read${REPLACEMENT}`,
        description: `reads${REPLACEMENT}`,
        parameters: { properties: { path: { description: `p${REPLACEMENT}` } } },
      },
    ]);
    expect(repairsOfKind(repairs, 'lone_surrogate')).toEqual([
      { kind: 'lone_surrogate', role: 'system', count: 3 },
    ]);
    expect(tools[0]?.description).toBe(`reads${LONE_TRAIL}`);
  });

  it('repairs lone surrogates in the system prompt', () => {
    const { systemPrompt, repairs } = sanitizeRequestSurface(`be kind${LONE_TRAIL}`, []);
    expect(systemPrompt).toBe(`be kind${REPLACEMENT}`);
    expect(repairsOfKind(repairs, 'lone_surrogate')).toEqual([
      { kind: 'lone_surrogate', role: 'system', count: 1 },
    ]);
  });

  it('passes a clean system prompt and clean tools through reference-equal', () => {
    const tools: Tool[] = [
      {
        name: 'read',
        description: 'reads',
        parameters: { properties: { path: { type: 'string' } } },
      },
    ];
    const { systemPrompt, tools: sanitized, repairs } = sanitizeRequestSurface('be kind', tools);
    expect(systemPrompt).toBe('be kind');
    expect(sanitized).toBe(tools);
    expect(repairs).toEqual([]);
  });
});

describe('resolveRequestSanitizeEnabled', () => {
  it('is enabled by default', () => {
    expect(resolveRequestSanitizeEnabled({})).toBe(true);
  });

  it('is disabled by the off value case-insensitively', () => {
    expect(resolveRequestSanitizeEnabled({ [REQUEST_SANITIZE_ENV]: 'off' })).toBe(false);
    expect(resolveRequestSanitizeEnabled({ [REQUEST_SANITIZE_ENV]: ' OFF ' })).toBe(false);
  });

  it('stays enabled for any other value', () => {
    expect(resolveRequestSanitizeEnabled({ [REQUEST_SANITIZE_ENV]: 'on' })).toBe(true);
    expect(resolveRequestSanitizeEnabled({ [REQUEST_SANITIZE_ENV]: '0' })).toBe(true);
  });
});

class FakeLlmRequester implements LlmRequester {
  readonly calls: Array<{ config: LlmRequestConfig; content: LlmRequestContent }> = [];

  async generate(
    config: LlmRequestConfig,
    content: LlmRequestContent,
    control: LlmRequestControl,
  ): Promise<void> {
    this.calls.push({ config, content });
    control.onEvent?.({ type: 'llm.sent' });
    control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'ok' } });
    control.onEvent?.({
      type: 'llm.streaming.finish',
      finish: { finishReason: 'completed', rawFinishReason: 'stop' },
    });
    control.onEvent?.({ type: 'llm.done' });
  }
}

const FAKE_LLM_MODEL: LlmModel = {
  provider: 'fake',
  model: 'fake-model',
  capability: { image_in: false, video_in: false, audio_in: false, thinking: false, tool_use: true },
  maxContextSize: 128000,
};

function gatewayReturning(requester: LlmRequester, protocol: Model['protocol']): ModelLlmGateway {
  return { resolve: () => ({ requester, protocol, model: FAKE_LLM_MODEL }) };
}

function fakeModel(): Model {
  return {
    id: 'm1',
    name: 'fake-model',
    aliases: [],
    protocol: 'openai',
    headers: {},
    capabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    },
    maxContextSize: 128000,
    alwaysThinking: false,
    providerType: 'fake',
    providerName: 'fake',
    credentialProvider: createStaticCredentialProvider(),
  };
}

async function drain(stream: AsyncIterable<ModelRequestEvent>): Promise<void> {
  for await (const event of stream) void event;
}

describe('ModelRequesterImpl request sanitizing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const poisoned: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: `look ${LONE_LEAD}` }],
      toolCalls: [],
    },
    toolMessage([
      { type: 'text', text: 'frames' },
      { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } },
    ]),
    { role: 'tool', content: [], toolCalls: [], toolCallId: 'call-2' },
  ];

  it('sanitizes messages before they reach the wire requester', async () => {
    const requester = new FakeLlmRequester();
    const impl = new ModelRequesterImpl(fakeModel(), gatewayReturning(requester, 'anthropic'));
    await drain(impl.request({ systemPrompt: 'sys', tools: [], messages: poisoned }));

    expect(requester.calls[0]?.content.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: `look ${REPLACEMENT}` }] },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: [
          { type: 'text', text: 'frames' },
          { type: 'text', text: OMITTED_TOOL_VIDEO_PLACEHOLDER },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call-2',
        content: [{ type: 'text', text: EMPTY_TOOL_OUTPUT_PLACEHOLDER }],
      },
    ]);
    expect(poisoned[0]?.content[0]).toEqual({ type: 'text', text: `look ${LONE_LEAD}` });
    expect(poisoned[2]?.content).toEqual([]);
  });

  it('passes messages through untouched when the env switch is off', async () => {
    vi.stubEnv(REQUEST_SANITIZE_ENV, 'off');
    const requester = new FakeLlmRequester();
    const observability: ModelRequesterObservability = {
      log: { warn: vi.fn() } as unknown as ModelRequesterObservability['log'],
      telemetry: { track2: vi.fn() } as unknown as ModelRequesterObservability['telemetry'],
    };
    const impl = new ModelRequesterImpl(
      fakeModel(),
      gatewayReturning(requester, 'anthropic'),
      observability,
    );
    await drain(impl.request({ systemPrompt: 'sys', tools: [], messages: poisoned }));

    expect(requester.calls[0]?.content.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: `look ${LONE_LEAD}` }],
    });
    expect(requester.calls[0]?.content.messages[2]).toEqual({
      role: 'tool',
      toolCallId: 'call-2',
      content: [],
    });
    expect(observability.log?.warn).not.toHaveBeenCalled();
    expect(observability.telemetry?.track2).not.toHaveBeenCalled();
  });

  it('reports repairs through warn log and telemetry once per repair signature', async () => {
    const requester = new FakeLlmRequester();
    const observability: ModelRequesterObservability = {
      log: { warn: vi.fn() } as unknown as ModelRequesterObservability['log'],
      telemetry: { track2: vi.fn() } as unknown as ModelRequesterObservability['telemetry'],
    };
    const impl = new ModelRequesterImpl(
      fakeModel(),
      gatewayReturning(requester, 'anthropic'),
      observability,
    );
    await drain(impl.request({ systemPrompt: 'sys', tools: [], messages: poisoned }));
    await drain(impl.request({ systemPrompt: 'sys', tools: [], messages: poisoned }));

    expect(observability.log?.warn).toHaveBeenCalledTimes(1);
    expect(observability.telemetry?.track2).toHaveBeenCalledTimes(1);
    expect(observability.telemetry?.track2).toHaveBeenCalledWith(
      'llm_request_sanitized',
      expect.objectContaining({
        lone_surrogates: 1,
        empty_tool_content: 1,
        tool_media_downgraded: 1,
      }),
    );
  });

  it('reads the switch from the bootstrapped env channel when one is provided', async () => {
    const requester = new FakeLlmRequester();
    const observability: ModelRequesterObservability = {
      env: (name) => (name === REQUEST_SANITIZE_ENV ? 'off' : undefined),
    };
    const impl = new ModelRequesterImpl(
      fakeModel(),
      gatewayReturning(requester, 'anthropic'),
      observability,
    );
    await drain(impl.request({ systemPrompt: 'sys', tools: [], messages: poisoned }));

    expect(requester.calls[0]?.content.messages[2]).toEqual({
      role: 'tool',
      toolCallId: 'call-2',
      content: [],
    });
  });

  it('lets the bootstrapped env channel win over the process env', async () => {
    vi.stubEnv(REQUEST_SANITIZE_ENV, 'off');
    const requester = new FakeLlmRequester();
    const observability: ModelRequesterObservability = {
      env: () => undefined,
    };
    const impl = new ModelRequesterImpl(
      fakeModel(),
      gatewayReturning(requester, 'anthropic'),
      observability,
    );
    await drain(impl.request({ systemPrompt: 'sys', tools: [], messages: poisoned }));

    expect(requester.calls[0]?.content.messages[2]).toEqual({
      role: 'tool',
      toolCallId: 'call-2',
      content: [{ type: 'text', text: EMPTY_TOOL_OUTPUT_PLACEHOLDER }],
    });
  });

  it('sanitizes the system prompt and request-level tools before they reach the wire requester', async () => {
    const requester = new FakeLlmRequester();
    const observability: ModelRequesterObservability = {
      log: { warn: vi.fn() } as unknown as ModelRequesterObservability['log'],
      telemetry: { track2: vi.fn() } as unknown as ModelRequesterObservability['telemetry'],
    };
    const impl = new ModelRequesterImpl(
      fakeModel(),
      gatewayReturning(requester, 'openai'),
      observability,
    );
    const tools: Tool[] = [
      { name: 'read', description: `reads${LONE_TRAIL}`, parameters: { type: 'object' } },
    ];
    await drain(
      impl.request({ systemPrompt: `be kind${LONE_LEAD}`, tools, messages: [userText('hi')] }),
    );

    expect(requester.calls[0]?.config.systemPrompt).toBe(`be kind${REPLACEMENT}`);
    expect(requester.calls[0]?.config.tools).toEqual([
      { name: 'read', description: `reads${REPLACEMENT}`, parameters: { type: 'object' } },
    ]);
    expect(observability.telemetry?.track2).toHaveBeenCalledWith(
      'llm_request_sanitized',
      expect.objectContaining({ lone_surrogates: 2 }),
    );
  });

  it('passes a clean system prompt and clean tools through reference-equal', async () => {
    const requester = new FakeLlmRequester();
    const impl = new ModelRequesterImpl(fakeModel(), gatewayReturning(requester, 'openai'));
    const tools: Tool[] = [
      { name: 'read', description: 'reads', parameters: { type: 'object' } },
    ];
    await drain(impl.request({ systemPrompt: 'be kind', tools, messages: [userText('hi')] }));

    expect(requester.calls[0]?.config.systemPrompt).toBe('be kind');
    expect(requester.calls[0]?.config.tools).toBe(tools);
  });
});
