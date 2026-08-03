/**
 * `kosong/model` ModelRequesterImpl tests — request execution against a fake
 * ChatProvider (the adapter registry is stubbed to return it, so no wire I/O
 * happens):
 *
 *  - `ModelRequestParams` map 1:1 onto `GenerateOptions` (cacheKey / sampling /
 *    thinking effort+keep / budget + window-clamp companions), with auth
 *    threaded per attempt;
 *  - the event stream carries parts, usage, finish, and timing;
 *  - a 401 against a refreshable auth provider forces one token refresh and
 *    exactly one replay; a 401 that survives the replay surfaces as
 *    `provider.auth_error`; other failures go through
 *    `translateProviderError`; an abort is rethrown untouched;
 *  - `uploadVideo` presence is the capability declaration;
 *  - `buildStreamTiming` splits TTFT at the request-sent boundary.
 */

import { describe, expect, it } from 'vitest';

import { isError2 } from '#/_base/errors/errors';
import { APIStatusError, createAbortError } from '#/kosong/contract/errors';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import type {
  ChatProvider,
  GenerateOptions,
  StreamedMessage,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import { emptyUsage, type TokenUsage } from '#/kosong/contract/usage';
import { ProtocolErrors } from '#/kosong/protocol/errors';
import type { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { Model } from '#/kosong/model/catalog';
import type { ModelRequestEvent } from '#/kosong/model/modelRequester';
import { effectiveMaxCompletionTokens } from '#/kosong/model/modelRequester';
import { buildStreamTiming, ModelRequesterImpl } from '#/kosong/model/modelRequesterImpl';

class FakeChatProvider implements ChatProvider {
  readonly name = 'fake-base';
  readonly modelName = 'fake-model';
  readonly thinkingEffort = null;

  uploadVideo?: ChatProvider['uploadVideo'];

  readonly calls: Array<{
    systemPrompt: string;
    tools: Tool[];
    history: unknown;
    options?: GenerateOptions;
  }> = [];

  handler: (callIndex: number) => Promise<StreamedMessage> = () =>
    Promise.resolve(streamOf([{ type: 'text', text: 'hello' }]));

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    this.calls.push({ systemPrompt, tools, history, options });
    options?.onRequestStart?.();
    options?.onRequestSent?.();
    const stream = await this.handler(this.calls.length - 1);
    return stream;
  }
}

function streamOf(
  parts: readonly StreamedMessagePart[],
  options: {
    readonly usage?: TokenUsage;
    readonly finishReason?: StreamedMessage['finishReason'];
    readonly rawFinishReason?: string | null;
    readonly id?: string | null;
    readonly traceId?: string | null;
  } = {},
): StreamedMessage {
  return {
    id: options.id ?? 'msg-1',
    usage: options.usage ?? emptyUsage(),
    finishReason: options.finishReason ?? 'completed',
    rawFinishReason: options.rawFinishReason ?? 'stop',
    traceId: options.traceId ?? null,
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

function registryReturning(provider: ChatProvider): IProtocolAdapterRegistry {
  return {
    _serviceBrand: undefined,
    supportedProtocols: () => [],
    resolveAdapterIdentity: () => {
      throw new Error('not needed');
    },
    resolveProviderBaseId: () => {
      throw new Error('not needed');
    },
    resolveCapability: () => {
      throw new Error('not needed');
    },
    createChatProvider: () => provider,
  } as unknown as IProtocolAdapterRegistry;
}

function modelWith(authProvider: Model['authProvider']): Model {
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
    authProvider,
  };
}

const staticAuth = (apiKey?: string): Model['authProvider'] => ({
  canRefresh: false,
  getAuth: () =>
    Promise.resolve(apiKey === undefined ? undefined : { apiKey }),
});

async function collect(stream: AsyncIterable<ModelRequestEvent>): Promise<ModelRequestEvent[]> {
  const events: ModelRequestEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const INPUT = { systemPrompt: 'sys', tools: [], messages: [] };

describe('ModelRequesterImpl request execution', () => {
  it('maps ModelRequestParams onto GenerateOptions 1:1', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(modelWith(staticAuth('sk-1')), registryReturning(provider));
    const signal = AbortSignal.timeout(1000);

    await collect(
      requester.request(
        { ...INPUT, responseFormat: { type: 'json_object' } },
        signal,
        {
          cacheKey: 'session-1',
          sampling: { temperature: 0.5, topP: 0.9 },
          thinkingEffort: 'high',
          thinkingKeep: 'all',
          maxCompletionTokens: 1024,
          usedContextTokens: 5000,
          maxContextTokens: 128000,
        },
      ),
    );

    expect(provider.calls).toHaveLength(1);
    const options = provider.calls[0]!.options;
    expect(options?.signal).toBe(signal);
    expect(options?.auth).toEqual({ apiKey: 'sk-1' });
    expect(options?.cacheKey).toBe('session-1');
    expect(options?.sampling).toEqual({ temperature: 0.5, topP: 0.9 });
    expect(options?.thinking).toEqual({ effort: 'high', keep: 'all' });
    expect(options?.maxCompletionTokens).toBe(1024);
    expect(options?.usedContextTokens).toBe(5000);
    expect(options?.maxContextTokens).toBe(128000);
    expect(options?.responseFormat).toEqual({ type: 'json_object' });
  });

  it('omits the thinking intent when no effort is requested', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));
    await collect(requester.request(INPUT));
    expect(provider.calls[0]?.options?.thinking).toBeUndefined();
    expect(provider.calls[0]?.options?.auth).toBeUndefined();
  });

  it('streams part, usage, finish, and timing events', async () => {
    const provider = new FakeChatProvider();
    provider.handler = () =>
      Promise.resolve(
        streamOf([{ type: 'text', text: 'hi' }], {
          usage: { ...emptyUsage(), output: 7 },
          id: 'msg-42',
          traceId: 'trace-1',
        }),
      );
    const traceIds: Array<string | null> = [];
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));
    const events = await collect(
      requester.request(INPUT, undefined, { onTraceId: (id) => traceIds.push(id) }),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual(['part', 'usage', 'finish', 'timing']);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { output: 7 }, model: 'fake-model' });
    const finish = events.find((e) => e.type === 'finish');
    expect(finish).toMatchObject({ id: 'msg-42', traceId: 'trace-1', providerFinishReason: 'completed' });
    const timing = events.find((e) => e.type === 'timing');
    // Decode stats are measured by the contract's generate() driver.
    expect(timing).toMatchObject({
      requestBuildMs: expect.any(Number),
      serverDecodeMs: expect.any(Number),
      clientConsumeMs: expect.any(Number),
    });
    expect(traceIds).toEqual(['trace-1']);
  });

  it('replays once after a forced token refresh on 401', async () => {
    const provider = new FakeChatProvider();
    provider.handler = (callIndex) =>
      callIndex === 0
        ? Promise.reject(new APIStatusError(401, 'unauthorized'))
        : Promise.resolve(streamOf([{ type: 'text', text: 'ok' }]));
    const authCalls: Array<{ force?: boolean }> = [];
    const requester = new ModelRequesterImpl(
      modelWith({
        canRefresh: true,
        getAuth: (options) => {
          authCalls.push(options ?? {});
          return Promise.resolve({ apiKey: authCalls.length === 1 ? 'tok-1' : 'tok-2' });
        },
      }),
      registryReturning(provider),
    );

    const events = await collect(requester.request(INPUT));
    expect(events.some((e) => e.type === 'finish')).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.options?.auth).toEqual({ apiKey: 'tok-1' });
    expect(provider.calls[1]?.options?.auth).toEqual({ apiKey: 'tok-2' });
    expect(authCalls).toEqual([{}, { force: true }]);
  });

  it('surfaces a replay-surviving 401 as provider.auth_error', async () => {
    const provider = new FakeChatProvider();
    provider.handler = () => Promise.reject(new APIStatusError(401, 'account rejected'));
    const requester = new ModelRequesterImpl(
      modelWith({
        canRefresh: true,
        getAuth: () => Promise.resolve({ apiKey: 'tok' }),
      }),
      registryReturning(provider),
    );

    const failure = await collect(requester.request(INPUT)).catch((error: unknown) => error);
    expect(isError2(failure)).toBe(true);
    expect((failure as { code: string }).code).toBe(ProtocolErrors.codes.PROVIDER_AUTH_ERROR);
    expect((failure as Error).message).toContain('account rejected');
    expect(provider.calls).toHaveLength(2);
  });

  it('does not replay 401s against a non-refreshable auth provider', async () => {
    const provider = new FakeChatProvider();
    provider.handler = () => Promise.reject(new APIStatusError(401, 'bad key'));
    const requester = new ModelRequesterImpl(
      modelWith(staticAuth('sk-bad')),
      registryReturning(provider),
    );

    const failure = await collect(requester.request(INPUT)).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(ProtocolErrors.codes.PROVIDER_AUTH_ERROR);
    expect(provider.calls).toHaveLength(1);
  });

  it('translates other provider failures and rethrows aborts untouched', async () => {
    const provider = new FakeChatProvider();
    provider.handler = () => Promise.reject(new APIStatusError(500, 'boom'));
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));
    const failure = await collect(requester.request(INPUT)).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(ProtocolErrors.codes.PROVIDER_API_ERROR);

    const abort = createAbortError();
    provider.handler = () => Promise.reject(abort);
    const aborted = await collect(requester.request(INPUT)).catch((error: unknown) => error);
    expect(aborted).toBe(abort);
  });

  it('uploadVideo presence is the capability declaration', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(
      modelWith(staticAuth('sk-1')),
      registryReturning(provider),
    );
    await expect(requester.uploadVideo('file-id')).rejects.toThrow(/does not support video upload/);

    const uploadCalls: Array<GenerateOptions | undefined> = [];
    provider.uploadVideo = (_input, options) => {
      uploadCalls.push(options);
      return Promise.resolve({ type: 'video_url', videoUrl: { url: 'https://cdn.example.test/v.mp4' } });
    };
    const part = await requester.uploadVideo('file-id');
    expect(part).toEqual({ type: 'video_url', videoUrl: { url: 'https://cdn.example.test/v.mp4' } });
    expect(uploadCalls[0]?.auth).toEqual({ apiKey: 'sk-1' });
  });
});

describe('effectiveMaxCompletionTokens', () => {
  it('reads the folded budget back from the params', () => {
    expect(effectiveMaxCompletionTokens(undefined)).toBeUndefined();
    expect(effectiveMaxCompletionTokens({})).toBeUndefined();
    expect(effectiveMaxCompletionTokens({ maxCompletionTokens: 512 })).toBe(512);
  });
});

describe('buildStreamTiming', () => {
  it('returns base TTFT and stream duration only', () => {
    expect(buildStreamTiming(100, undefined, 250, 400, undefined)).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
    });
  });

  it('splits TTFT across the request-sent boundary', () => {
    expect(buildStreamTiming(100, 180, 250, 400, undefined)).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 80,
      serverFirstTokenMs: 70,
    });
  });

  it('adds decode stats when present', () => {
    expect(
      buildStreamTiming(100, 120, 250, 400, { serverDecodeMs: 90, clientConsumeMs: 60 }),
    ).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 20,
      serverFirstTokenMs: 130,
      serverDecodeMs: 90,
      clientConsumeMs: 60,
    });
  });
});
