import { afterEach, describe, expect, it, vi } from 'vitest';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { kimiOpenAIProtocol } from '#/llm/builtin/provider/kimi/index';
import { kimiAnthropicRequester, kimiRequester } from '#/llm/builtin/provider/index';
import { generate, type LlmAttemptEvent } from '#/llm/generate';
import { createToolMessage, createUserMessage, isMediaPart, type Message } from '#/llm/message';
import { createRecoveryLedger } from '#/llm/policy/recovery';
import type { LlmModelSpec, LlmRequest } from '#/llm/request';
import { BASELINE_IMAGE_MIMES } from '#/llm/protocol/kit/media';
import type { LlmNotice, LlmNoticeInput, LlmRunEvent } from '#/llm/response';
import { createMediaDegradeRecovery } from '#/llm/builtin/policy/media-degrade';
import { memoryBlobBackend } from '#/blob/backend/memory';
import { openBlobCache } from '#/blob/index';
import {
  createBlobUploadCache,
  createStoreRefResolver,
  type RefStore,
  type StoredContent,
  type UploadCache,
} from '#/llm/builtin/policy/store-ref/index';

function createMemoryRefStore(entries: Readonly<Record<string, StoredContent>>): RefStore {
  return { get: async (ref) => entries[ref] };
}

function createMemoryUploadCache(): UploadCache {
  return createBlobUploadCache(openBlobCache(memoryBlobBackend(), 'media-upload'));
}

const spec: LlmModelSpec = { provider: 'kimi', name: 'kimi-k2' };
const videoSpec: LlmModelSpec = {
  ...spec,
  capability: { image_in: false, video_in: true, thinking: true },
  thinking: { supportEfforts: ['low', 'high'] },
};

function createAsyncStream<T>(chunks: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

interface Captured {
  readonly params: Record<string, unknown>;
  readonly options: { readonly headers?: Record<string, string> } | undefined;
}

function createCall(captured: Captured[], replies: readonly (() => unknown)[]) {
  return (params: Record<string, unknown>, options?: Captured['options']) => {
    const reply = replies[captured.length];
    captured.push({ params, options });
    return {
      withResponse: async () => ({
        data: reply?.(),
        response: new Response(null, { headers: { 'x-trace-id': 'trace-1', 'request-id': 'req-1' } }),
      }),
    };
  };
}

async function run(request: LlmRequest): Promise<LlmAttemptEvent[]> {
  const events: LlmAttemptEvent[] = [];
  await generate(request, {
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  return events;
}

const history: Message[] = [
  {
    role: 'system',
    content: [{ type: 'text', text: 'deferred tools' }],
    tools: [{ name: 'later', description: 'later tool', parameters: { type: 'object' } }],
  },
  createUserMessage('find it'),
  {
    role: 'assistant',
    content: [{ type: 'text', text: ' ' }],
    toolCalls: [
      {
        type: 'function',
        id: 'call:1',
        name: 'lookup',
        arguments: '{"q":"a"}',
        extras: { origin: 'kimi' },
      },
    ],
  },
  createToolMessage('call:1', 'found'),
];

describe('kimi provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads store videos once, lowers kimi openai requests through every pass and decodes choice-level usage', async () => {
    const uploads: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.startsWith('data:')) return new Response('');
      uploads.push(url);
      return Response.json({ id: 'file_1', object: 'file', purpose: 'video', status: 'processed' });
    });
    const memory = createMemoryRefStore({
      'file:///media/clip.mp4': {
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
      },
      'file:///media/frame.png': { bytes: new Uint8Array([5, 6]), mimeType: 'image/png' },
    });
    const reads: string[] = [];
    const resolver = createStoreRefResolver({
      store: {
        get: (ref) => {
          reads.push(ref);
          return memory.get(ref);
        },
      },
      cache: createMemoryUploadCache(),
    });
    const videoMessage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'watch' },
        { type: 'video_url', source: { kind: 'store', ref: 'file:///media/clip.mp4' } },
        { type: 'image_url', source: { kind: 'store', ref: 'file:///media/frame.png' } },
      ],
    };
    const captured: Captured[] = [];
    const chunks = [
      {
        id: 'chatcmpl-1',
        choices: [
          {
            index: 0,
            delta: { content: 'done' },
            finish_reason: 'stop',
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          },
        ],
      },
    ];
    const draft = kimiRequester.request({
      protocol: { options: { extras: { extra_body: { safe_mode: true } } } },
      endpoint: {
        clientFactory: () => ({
          chat: { completions: { create: createCall(captured, [() => createAsyncStream(chunks)]) } },
        }),
      },
      model: {
        spec: videoSpec,
        thinking: { effort: 'high', keep: 'all' },
        maxOutputTokens: 1000,
        cacheKey: 's1',
      },
      profile: {
        systemPrompt: 'be brief',
        tools: [
          { name: '$web_search', description: 'builtin', parameters: {} },
          {
            name: 'lookup',
            description: 'lookup',
            parameters: { type: 'object', properties: { q: { enum: ['a', 'b'] } } },
          },
        ],
      },
      content: { messages: [...history, videoMessage] },
    });
    const resolveContext = {
      model: draft.model.spec,
      endpoint: draft.endpoint,
      media: draft.protocol.base.media,
      signal: new AbortController().signal,
      report: () => {},
    };
    const resolve = () => resolver.resolve(draft.content.messages, resolveContext);
    const request = { ...draft, content: { messages: await resolve() } };
    await resolve();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(/\/files$/);
    expect(draft.content.messages.at(-1)).toBe(videoMessage);
    const imageContext = { ...resolveContext, model: { ...spec, capability: { image_in: true } } };
    const frameOnly: Message[] = [{ role: 'user', content: [videoMessage.content[2]!] }];
    await resolver.resolve(frameOnly, imageContext);
    const [frame] = await resolver.resolve(frameOnly, imageContext);
    expect(frame?.content[0]).toMatchObject({ source: { kind: 'url', url: 'ms://file_1' } });
    expect(uploads).toHaveLength(2);
    expect(reads.filter((ref) => ref === 'file:///media/frame.png')).toHaveLength(1);

    const budgetNotices: LlmNotice[] = [];
    const budgetResolver = createStoreRefResolver(
      {
        store: createMemoryRefStore({
          b1: { bytes: new Uint8Array([1, 2, 3, 4, 5, 6]), mimeType: 'image/png' },
          b2: { bytes: new Uint8Array([7, 8, 9, 10, 11, 12]), mimeType: 'image/png' },
          disguised: { bytes: new Uint8Array([0x42, 0x4d, 1, 2]), mimeType: 'image/png' },
        }),
        cache: createMemoryUploadCache(),
      },
      { budget: { maxBytes: 10, lowBytes: 8 } },
    );
    const budgetContext = {
      ...imageContext,
      endpoint: {},
      media: { kinds: { image: { mimes: BASELINE_IMAGE_MIMES, sources: ['inline' as const], inToolResult: 'native' as const } } },
      report: (notice: LlmNoticeInput) => budgetNotices.push({ ...notice, source: 'media' }),
    };
    const store = (ref: string) => ({ type: 'image_url' as const, source: { kind: 'store' as const, ref } });
    const [budgeted] = await budgetResolver.resolve(
      [{ role: 'user', content: [store('b1'), store('b2'), store('disguised')] }],
      budgetContext,
    );
    expect(budgeted?.content).toEqual([
      { type: 'text', text: '[image omitted: dropped to fit the request media budget]' },
      { ...store('b2'), source: { kind: 'inline', mimeType: 'image/png', data: 'BwgJCgsM' } },
      { type: 'text', text: '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]' },
    ]);
    expect(budgetNotices).toMatchObject([{ code: 'media-budget-exceeded', data: { dropped: 1 } }]);
    const [sticky] = await budgetResolver.resolve([{ role: 'user', content: [store('b1')] }], budgetContext);
    expect(sticky?.content).toEqual([
      { type: 'text', text: '[image omitted: dropped to fit the request media budget]' },
    ]);

    const image = (ref: string) => ({ type: 'image_url' as const, source: { kind: 'store' as const, ref } });
    const gallery: Message[] = [{ role: 'user', content: [image('m1'), image('m2'), image('m3')] }];
    const tooLarge = {
      kind: 'request_too_large',
      message: 'big',
      statusCode: 413,
      requestId: null,
      retryAfterMs: null,
      headers: null,
    } as const;
    const degradeRecovery = createMediaDegradeRecovery();
    const ledger = createRecoveryLedger();
    const propose = (messages: readonly Message[]) =>
      degradeRecovery.propose({ error: tooLarge, messages, appliedRecoveries: ledger.applied });
    ledger.record(propose(gallery)!);
    const degraded = ledger.apply(gallery);
    ledger.record(propose(degraded)!);
    const later = ledger.apply([...gallery, { role: 'user', content: [image('m4')] }]);
    const omissions = (messages: readonly Message[]) =>
      messages.flatMap((message) =>
        message.content.map((part) => (isMediaPart(part) ? (part.omitted ?? 'live') : part.type)),
      );
    expect(ledger.applied.map((record) => record.action)).toEqual(['degraded', 'stripped']);
    expect(omissions(degraded)).toEqual(['degraded', 'live', 'live']);
    expect(omissions(later)).toEqual(['stripped', 'stripped', 'stripped', 'live']);
    const tagged = await createStoreRefResolver({
      store: memory,
      cache: createMemoryUploadCache(),
      placeholder: ({ kind, reason, ref }) => (ref === 'm1' ? `<${kind} path="${ref}" ${reason}>` : undefined),
    }).resolve(later, imageContext);
    expect(tagged.flatMap((message) => message.content)).toEqual([
      { type: 'text', text: '<image path="m1" stripped>' },
      { type: 'text', text: '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]' },
      { type: 'text', text: '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]' },
      { type: 'text', text: '[image omitted: media unavailable]' },
    ]);
    const fallback = kimiOpenAIProtocol.encode({
      model: { spec: imageContext.model },
      profile: {},
      content: { messages: [{ role: 'user', content: [degraded[0]!.content[0]!, { type: 'text', text: 'see' }] }] },
      options: undefined,
    }).params as unknown as { messages: { content: unknown }[] };
    expect(fallback.messages[0]?.content).toEqual([
      { type: 'text', text: '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]' },
      { type: 'text', text: 'see' },
    ]);

    let fileUploads = 0;
    const fileContext = {
      ...budgetContext,
      media: anthropicProtocol.media,
      endpoint: {
        files: {
          kinds: new Set(['image' as const]),
          upload: async (file: { readonly mimeType: string }) => {
            fileUploads += 1;
            return {
              source: { kind: 'file' as const, id: `f-${fileUploads}`, mimeType: file.mimeType },
              expiresAt: Date.now() - 1,
            };
          },
        },
      },
    };
    const fileResolver = createStoreRefResolver({
      store: createMemoryRefStore({ p1: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' } }),
      cache: createMemoryUploadCache(),
    });
    const resolveFile = async () =>
      (await fileResolver.resolve([{ role: 'user', content: [store('p1')] }], fileContext))[0]?.content[0];
    expect(await resolveFile()).toMatchObject({ source: { kind: 'file', id: 'f-1', mimeType: 'image/png' } });
    expect(await resolveFile()).toMatchObject({ source: { kind: 'file', id: 'f-2' } });

    const mediaSpec = { provider: 'test', name: 'claude-sonnet-4-5', capability: { image_in: true, audio_in: true } };
    const fileImage = { type: 'image_url' as const, source: { kind: 'file' as const, id: 'f-1', mimeType: 'image/png' } };
    const urlAudio = { type: 'audio_url' as const, source: { kind: 'url' as const, url: 'https://example.test/a.mp3' } };
    const encodeWith = (protocol: { encode: (module: never) => unknown }, messages: Message[]) =>
      protocol.encode({ model: { spec: mediaSpec }, profile: {}, content: { messages }, options: undefined } as never) as {
        params: Record<string, unknown>;
        betas?: string[];
      };
    const anthropicNative = encodeWith(anthropicProtocol, [{ role: 'user', content: [fileImage, urlAudio] }]);
    expect((anthropicNative.params['messages'] as { content: unknown[] }[])[0]?.content).toMatchObject([
      { type: 'image', source: { type: 'file', file_id: 'f-1' } },
      { type: 'text', text: '[audio omitted: not supported by this provider]' },
    ]);
    expect(anthropicNative.betas).toContain('files-api-2025-04-14');
    const googleNative = encodeWith(googleGenAIProtocol, [{ role: 'user', content: [fileImage] }]);
    expect(googleNative.params['contents']).toMatchObject([
      { role: 'user', parts: [{ fileData: { fileUri: 'f-1', mimeType: 'image/png' } }] },
    ]);
    const shot = { type: 'image_url' as const, source: { kind: 'url' as const, url: 'https://example.test/shot.png' } };
    const chatNative = encodeWith(openAIProtocol, [
      { role: 'user', content: [{ type: 'text', text: 'q' }, fileImage] },
      { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'c1', name: 'lookup', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'shot' }, shot, urlAudio] },
    ]);
    expect(chatNative.params['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q' },
          { type: 'text', text: '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]' },
        ],
      },
      expect.objectContaining({ role: 'assistant' }),
      { role: 'tool', tool_call_id: 'c1', content: 'shot\n[audio omitted: not supported by this provider]' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Attached media from tool result:' },
          { type: 'image_url', image_url: { url: 'https://example.test/shot.png' } },
        ],
      },
    ]);

    const passes: string[] = [];
    const notices: LlmNotice[] = [];
    const module = {
      model: request.model,
      profile: request.profile ?? {},
      content: request.content,
      options: request.protocol.options,
    };
    request.protocol.base.encode(module, { trace: (pass) => passes.push(pass) });
    const call = (id: string) => ({ type: 'function' as const, id, name: 'lookup', arguments: '{}' });
    const encodeMessages = (messages: Message[]) =>
      kimiOpenAIProtocol.encode(
        {
          model: { spec },
          profile: {
            tools: [
              { name: 'later', description: 'later', parameters: {}, deferred: true },
              { name: 'lookup', description: 'lookup', parameters: {} },
            ],
          },
          content: { messages },
          options: undefined,
        },
        { report: (notice) => notices.push(notice) },
      ).params as unknown as { messages: Record<string, unknown>[]; tools: unknown[] };
    const calls = { role: 'assistant' as const, content: [{ type: 'text' as const, text: '  ' }], toolCalls: [call('a'), call('b')] };
    const repaired = encodeMessages([
      createUserMessage('q'),
      calls,
      createUserMessage('interject'),
      createToolMessage('b', 'B'),
      createToolMessage('a', 'A'),
    ]);
    expect(notices.map((notice) => [notice.source, notice.code])).toEqual([
      ['legalize-structure', 'whitespace_text_dropped'],
      ['legalize-structure', 'tool_result_reordered'],
      ['legalize-structure', 'tool_result_reordered'],
    ]);
    const answered = [createUserMessage('q'), calls, createToolMessage('a', 'A'), createToolMessage('b', 'B')];
    expect(() => encodeMessages([...answered, createToolMessage('x', 'orphan')])).toThrow('no preceding tool call');
    expect(() => encodeMessages(answered.slice(0, 3))).toThrow('without a result: b');
    expect(() => encodeMessages([...answered, { ...calls, toolCalls: [call('a')] }])).toThrow('more than one tool call');
    expect(repaired.messages.map((message) => [message['role'], message['tool_call_id']])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'a'],
      ['tool', 'b'],
      ['user', undefined],
    ]);
    expect(repaired.tools).toHaveLength(1);
    const budget = (maxOutputTokens?: number | 'none') =>
      (
        kimiOpenAIProtocol.encode({
          model: { spec: { ...spec, maxContextSize: 1000 }, maxOutputTokens },
          profile: {},
          content: { messages: [createUserMessage('q')], usedTokens: 400 },
          options: undefined,
        }).params as unknown as Record<string, unknown>
      )['max_completion_tokens'];
    expect([budget(), budget(5000), budget(100), budget('none')]).toEqual([600, 600, 100, undefined]);
    expect(passes).toEqual([
      'legalize-media',
      'verify-history',
      'legalize-structure',
      'relocate-tool-media',
      'legalize-tool-call-ids',
      'legalize-thinking-history',
      'legalize-model',
      'convert',
      'merge-turns',
      'annotate-cache',
      'finalize-params',
      'flatten',
    ]);

    const events = await run(request);
    const body = captured[0]?.params ?? {};
    expect(body['thinking']).toEqual({ type: 'enabled', effort: 'high', keep: 'all' });
    expect(body['max_completion_tokens']).toBe(1000);
    expect(body['max_tokens']).toBeUndefined();
    expect(body['prompt_cache_key']).toBe('s1');
    expect(body['safe_mode']).toBe(true);
    expect(body['extra_body']).toBeUndefined();
    expect(body['stream']).toBe(true);
    const tools = body['tools'] as Record<string, unknown>[];
    expect(tools[0]).toEqual({ type: 'builtin_function', function: { name: '$web_search' } });
    expect(tools[1]).toMatchObject({
      function: { parameters: { properties: { q: { type: 'string', enum: ['a', 'b'] } } } },
    });
    const wireMessages = body['messages'] as Record<string, unknown>[];
    expect(wireMessages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(wireMessages[1]).toMatchObject({
      role: 'system',
      tools: [{ type: 'function', function: { name: 'later' } }],
    });
    expect('content' in (wireMessages[3] ?? {})).toBe(false);
    expect(wireMessages[3]).toMatchObject({
      reasoning_content: '',
      tool_calls: [{ id: 'call_1', extras: { origin: 'kimi' } }],
    });
    expect(wireMessages[4]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'found' });
    expect(wireMessages[5]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'watch' },
        { type: 'video_url', video_url: { url: 'ms://file_1' } },
        { type: 'text', text: '[image omitted: not supported by this model]' },
      ],
    });
    expect(events).toContainEqual({
      type: 'llm.streaming.usage',
      usage: {
        inputOther: 7,
        output: 3,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        raw: { prompt_tokens: 7, completion_tokens: 3 },
      },
    });
    expect(events.some((event) => event.type === 'attempt.failed')).toBe(false);
  });

  it('uses the beta api with context-management betas for kimi anthropic and classifies quota errors', async () => {
    const captured: Captured[] = [];
    const events = [
      { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ];
    const quota = Object.assign(new Error('You exceeded your current quota'), {
      status: 429,
      error: { type: 'exceeded_current_quota_error' },
    });
    const requester = kimiAnthropicRequester.with({
      endpoint: {
        clientFactory: () => ({
          beta: {
            messages: {
              create: createCall(captured, [
                () => createAsyncStream(events),
                () => {
                  throw quota;
                },
                () => createAsyncStream(events),
              ]),
            },
          },
        }),
      },
      model: { spec: { ...spec, capability: { image_in: true } }, thinking: { effort: 'high' } },
      profile: {
        systemPrompt: 'be brief',
        tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }],
      },
    });
    const content = {
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: 'look' },
            {
              type: 'image_url' as const,
              source: { kind: 'inline' as const, mimeType: 'image/bmp', data: 'AAAA' },
            },
          ],
        },
      ],
    };

    const done = await run(requester.request({ content }));
    expect(done.some((event) => event.type === 'attempt.failed')).toBe(false);
    const call = captured[0];
    expect(call?.options?.headers).toBeUndefined();
    expect(call?.params).toMatchObject({
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
      betas: ['context-management-2025-06-27'],
      system: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'lookup', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/bmp' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    });

    const failed = await run(requester.request({ content }));
    expect(failed).toContainEqual(
      expect.objectContaining({
        type: 'attempt.failed',
        error: expect.objectContaining({ kind: 'quota_exhausted', statusCode: 429 }),
      }),
    );

    const boundary: LlmRunEvent[] = [];
    const settled = await requester.generate(
      { content },
      { signal: new AbortController().signal, onEvent: (event) => boundary.push(event) },
    );
    expect(boundary[0]).toEqual({ type: 'llm.started' });
    expect(boundary.filter((event) => event.type === 'llm.started' || event.type === 'llm.ended')).toHaveLength(2);
    expect(boundary.at(-1)).toEqual({ type: 'llm.ended', outcome: settled });
    expect(settled).toMatchObject({
      type: 'done',
      requestId: 'trace-1',
      timing: {
        firstTokenLatencyMs: expect.any(Number),
        streamDurationMs: expect.any(Number),
        requestBuildMs: expect.any(Number),
        serverFirstTokenMs: expect.any(Number),
        serverDecodeMs: expect.any(Number),
        clientConsumeMs: expect.any(Number),
        clientBlockedMs: expect.any(Number),
      },
    });
    expect(anthropicProtocol.requestId?.({ 'Request-Id': 'req-1' })).toBe('req-1');
  });
});
