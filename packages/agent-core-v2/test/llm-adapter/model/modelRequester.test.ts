import { describe, expect, it } from 'vitest';

import { isError2 } from '#/_base/errors/errors';
import { oauthCredentials, staticCredentials } from '#human/credentials/credentials';
import type { ProviderMediaContribution } from '#human/llm/media/upload';
import type { LlmModel } from '#human/llm/model';
import type {
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequestControl,
  LlmRequestEvent,
  LlmRequester,
} from '#human/llm/requester/requester';
import {
  APIEmptyResponseError,
  APIStatusError,
  ChatProviderError,
  PROVIDER_API_ERROR_CODE,
  PROVIDER_AUTH_ERROR_CODE,
  isAbortError,
} from '#/llm-adapter/contract/errors';
import type { Message } from '#/llm-adapter/contract/message';
import type { Model } from '#/llm-adapter/model/catalog';
import type { ModelRequestEvent } from '#/llm-adapter/model/model-requester';
import { effectiveMaxCompletionTokens } from '#/llm-adapter/model/model-requester';
import {
  buildStreamTiming,
  ModelRequesterImpl,
  type ModelLlmGateway,
} from '#/llm-adapter/model/model-requester-impl';

class FakeLlmRequester implements LlmRequester {
  readonly calls: Array<{
    config: LlmRequestConfig;
    content: LlmRequestContent;
    control: LlmRequestControl;
  }> = [];

  handler: (callIndex: number, emit: (event: LlmRequestEvent) => void) => void | Promise<void> =
    () => {};

  async generate(
    config: LlmRequestConfig,
    content: LlmRequestContent,
    control: LlmRequestControl,
  ): Promise<void> {
    this.calls.push({ config, content, control });
    await this.handler(this.calls.length - 1, (event) => control.onEvent?.(event));
  }
}

const BASE_LLM_MODEL: LlmModel = {
  provider: 'fake',
  model: 'fake-model',
  capability: {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
  },
  maxContextSize: 128000,
};

function gatewayReturning(
  requester: LlmRequester,
  media?: ProviderMediaContribution,
): ModelLlmGateway {
  return {
    resolve: () => ({ requester, protocol: 'openai', model: BASE_LLM_MODEL, media }),
  };
}

function emitAll(emit: (event: LlmRequestEvent) => void, events: readonly LlmRequestEvent[]): void {
  for (const event of events) emit(event);
}

function textStream(emit: (event: LlmRequestEvent) => void, text = 'hello'): void {
  emitAll(emit, [
    { type: 'llm.sent' },
    { type: 'llm.streaming.part', part: { type: 'text', text } },
    { type: 'llm.streaming.finish', finish: { finishReason: 'completed', rawFinishReason: 'stop' } },
    { type: 'llm.done' },
  ]);
}

function modelWith(credentials: Model['credentials']): Model {
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
    credentials,
  };
}

async function collect(stream: AsyncIterable<ModelRequestEvent>): Promise<ModelRequestEvent[]> {
  const events: ModelRequestEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const INPUT = { systemPrompt: 'sys', tools: [], messages: [] };

describe('ModelRequesterImpl request execution', () => {
  it('maps ModelRequestParams onto LlmRequestConfig, content and control', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => textStream(emit);
    const impl = new ModelRequesterImpl(modelWith(staticCredentials('sk-1')), gatewayReturning(requester));
    const signal = AbortSignal.timeout(1000);
    const messages: Message[] = [
      {
        role: 'system',
        content: [{ type: 'text', text: 's' }],
        toolCalls: [],
        tools: [{ name: 'decl', description: 'd', parameters: {} }],
      },
      { role: 'user', content: [{ type: 'text', text: 'u' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 't', arguments: '{}' }],
        partial: true,
      },
      { role: 'tool', content: [{ type: 'text', text: 'r' }], toolCalls: [], toolCallId: 'c1' },
    ];

    await collect(
      impl.request(
        {
          systemPrompt: 'sys',
          tools: [
            { name: 'a', description: 'da', parameters: {} },
            { name: 'b', description: 'db', parameters: {}, deferred: true },
          ],
          messages,
          responseFormat: { type: 'json_object' },
        },
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

    expect(requester.calls).toHaveLength(1);
    const call = requester.calls[0]!;
    expect(call.config.systemPrompt).toBe('sys');
    expect(call.config.tools).toEqual([{ name: 'a', description: 'da', parameters: {} }]);
    expect(call.config.cacheKey).toBe('session-1');
    expect(call.config.thinking).toEqual({ effort: 'high', keep: 'all' });
    expect(call.config.responseFormat).toEqual({ type: 'json_object' });
    expect(call.config.maxCompletionTokens).toBe(1024);
    expect(call.config.maxContextTokens).toBe(128000);
    expect(call.config.extraParams).toEqual({ openai: { temperature: 0.5, top_p: 0.9 } });
    expect(call.config.model.apiKey).toBe('sk-1');
    expect(call.content.usedContextTokens).toBe(5000);
    expect(call.content.messages).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 's' }],
        tools: [{ name: 'decl', description: 'd', parameters: {} }],
      },
      { role: 'user', content: [{ type: 'text', text: 'u' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 't', arguments: '{}' }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'r' }], toolCallId: 'c1' },
    ]);
    expect(call.control.signal).toBe(signal);
  });

  it('omits the thinking intent when no effort is requested', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => textStream(emit);
    const impl = new ModelRequesterImpl(modelWith(staticCredentials()), gatewayReturning(requester));
    await collect(impl.request(INPUT));
    expect(requester.calls[0]?.config.thinking).toBeUndefined();
    expect(requester.calls[0]?.config.extraParams).toBeUndefined();
    expect(requester.calls[0]?.config.model.apiKey).toBeUndefined();
  });

  it('streams part, usage, finish and timing events exactly once', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) =>
      emitAll(emit, [
        { type: 'llm.sent' },
        { type: 'llm.streaming.headers', headers: { 'x-trace-id': 'trace-1' } },
        { type: 'llm.streaming.part', part: { type: 'text', text: 'he' } },
        { type: 'llm.streaming.part', part: { type: 'text', text: 'llo' } },
        {
          type: 'llm.streaming.part',
          part: { type: 'function', id: 'call-1', name: 'do', arguments: '{"a"', _streamIndex: 0 },
        },
        { type: 'llm.streaming.part', part: { type: 'tool_call_part', argumentsPart: ':1}', index: 0 } },
        { type: 'llm.streaming.usage', usage: { inputOther: 10 } },
        { type: 'llm.streaming.usage', usage: { output: 7 } },
        { type: 'llm.streaming.finish', finish: { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' } },
        { type: 'llm.streaming.message_id', messageId: 'msg-42' },
        { type: 'llm.done' },
      ]);
    const traceIds: Array<string | null> = [];
    const impl = new ModelRequesterImpl(modelWith(staticCredentials()), gatewayReturning(requester));
    const events = await collect(
      impl.request(INPUT, undefined, { onTraceId: (id) => traceIds.push(id) }),
    );

    expect(events.map((e) => e.type)).toEqual([
      'part',
      'part',
      'part',
      'part',
      'usage',
      'finish',
      'timing',
    ]);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { inputOther: 10, output: 7 }, model: 'fake-model' });
    const finish = events.find((e) => e.type === 'finish');
    expect(finish).toMatchObject({
      id: 'msg-42',
      traceId: 'trace-1',
      providerFinishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        toolCalls: [{ type: 'function', id: 'call-1', name: 'do', arguments: '{"a":1}' }],
      },
    });
    const timing = events.find((e) => e.type === 'timing');
    expect(timing).toMatchObject({
      firstTokenLatencyMs: expect.any(Number),
      streamDurationMs: expect.any(Number),
    });
    expect(traceIds).toEqual(['trace-1']);
  });

  it('surfaces a 401 as provider.auth_error without replaying', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) =>
      emit({
        type: 'llm.failed.remote',
        error: {
          kind: 'status',
          statusCode: 401,
          message: 'account rejected',
          requestId: null,
          retryAfterMs: null,
          headers: null,
        },
      });
    const impl = new ModelRequesterImpl(
      modelWith(oauthCredentials(() => Promise.resolve('tok'))),
      gatewayReturning(requester),
    );

    const failure = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect(isError2(failure)).toBe(true);
    expect((failure as { code: string }).code).toBe(PROVIDER_AUTH_ERROR_CODE);
    expect((failure as Error).message).toContain('account rejected');
    expect(requester.calls).toHaveLength(1);
  });

  it('does not replay 401s against static credentials', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) =>
      emit({
        type: 'llm.failed.remote',
        error: {
          kind: 'status',
          statusCode: 401,
          message: 'bad key',
          requestId: null,
          retryAfterMs: null,
          headers: null,
        },
      });
    const impl = new ModelRequesterImpl(
      modelWith(staticCredentials('sk-bad')),
      gatewayReturning(requester),
    );

    const failure = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(PROVIDER_AUTH_ERROR_CODE);
    expect(requester.calls).toHaveLength(1);
  });

  it('translates remote, syntax and empty-response failures and rethrows aborts untouched', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) =>
      emit({
        type: 'llm.failed.remote',
        error: {
          kind: 'status',
          statusCode: 500,
          message: 'boom',
          requestId: null,
          retryAfterMs: null,
          headers: null,
        },
      });
    const impl = new ModelRequesterImpl(modelWith(staticCredentials()), gatewayReturning(requester));
    const failure = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(PROVIDER_API_ERROR_CODE);

    requester.handler = (_i, emit) =>
      emit({
        type: 'llm.failed.syntax',
        error: { kind: 'syntax', code: 'request_format', message: 'bad request shape' },
      });
    const syntaxFailure = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect(syntaxFailure).toBeInstanceOf(ChatProviderError);
    expect((syntaxFailure as { code: string }).code).toBe(PROVIDER_API_ERROR_CODE);

    requester.handler = (_i, emit) =>
      emit({ type: 'llm.failed.remote', error: { kind: 'abort', message: 'aborted' } });
    const aborted = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect(isAbortError(aborted)).toBe(true);

    requester.handler = (_i, emit) => emit({ type: 'llm.done' });
    const empty = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect(empty).toBeInstanceOf(APIEmptyResponseError);
    expect((empty as { code: string }).code).toBe(PROVIDER_API_ERROR_CODE);
  });

  it('uploadVideo presence is the capability declaration', async () => {
    const requester = new FakeLlmRequester();
    const impl = new ModelRequesterImpl(
      modelWith(staticCredentials('sk-1')),
      gatewayReturning(requester),
    );
    await expect(impl.uploadVideo('file-id')).rejects.toThrow(/does not support video upload/);

    const seen: Array<string | undefined> = [];
    const media: ProviderMediaContribution = {
      uploadVideo: (_video, options) => {
        seen.push(options.model.apiKey);
        return Promise.resolve({
          type: 'video_url',
          videoUrl: { url: 'https://cdn.example.test/v.mp4' },
        });
      },
    };
    const withMedia = new ModelRequesterImpl(
      modelWith(staticCredentials('sk-1')),
      gatewayReturning(requester, media),
    );
    const part = await withMedia.uploadVideo({ data: new Uint8Array([1]), mimeType: 'video/mp4' });
    expect(part).toEqual({ type: 'video_url', videoUrl: { url: 'https://cdn.example.test/v.mp4' } });
    expect(seen).toEqual(['sk-1']);
  });

  it('reports the event-loop-busy overlap of the decode window as clientBlockedMs', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => {
      emit({ type: 'llm.sent' });
      emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'a' } });
      const spinUntil = Date.now() + 150;
      while (Date.now() < spinUntil) {}
      emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'b' } });
      emit({ type: 'llm.streaming.finish', finish: { finishReason: 'completed', rawFinishReason: 'stop' } });
      emit({ type: 'llm.done' });
    };
    const impl = new ModelRequesterImpl(modelWith(staticCredentials()), gatewayReturning(requester));
    const events = await collect(impl.request(INPUT));
    const timing = events.find((event) => event.type === 'timing');
    expect(timing).toBeDefined();
    if (timing?.type !== 'timing') return;
    expect(timing.serverDecodeMs).toBeGreaterThanOrEqual(140);
    expect(timing.clientBlockedMs).toBeGreaterThanOrEqual(100);
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

  it('adds the blocked share of the decode window when reported', () => {
    expect(
      buildStreamTiming(100, 120, 250, 400, {
        serverDecodeMs: 10,
        clientConsumeMs: 60,
        clientBlockedMs: 80,
      }),
    ).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 20,
      serverFirstTokenMs: 130,
      serverDecodeMs: 10,
      clientConsumeMs: 60,
      clientBlockedMs: 80,
    });
  });
});
