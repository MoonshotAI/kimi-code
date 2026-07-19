/**
 * `kosong/model` domain (L2) — `ModelRequesterImpl`, the request executor.
 *
 * This is the ONLY production code that calls
 * `IProtocolAdapterRegistry.createChatProvider`: it lazily composes exactly
 * one immutable ChatProvider per Model (on first use) and caches it for the
 * Model's lifetime; every per-turn variation arrives as `LLMCallParams` and
 * is mapped onto `GenerateOptions` (overlay order inside the bases:
 * `cacheKey → sampling → thinking → maxCompletionTokens`).
 *
 * The driver itself turns per-turn input (systemPrompt / tools / messages)
 * into the `LLMEvent` stream via the contract's `generate(...)`, measures
 * stream timing (`buildStreamTiming`), and owns the auth-refresh replay: a
 * 401 against a refreshable (OAuth) auth provider triggers one forced token
 * refresh and exactly one replay; a 401 that survives the replay means the
 * provider rejected the account itself, so it is surfaced through
 * `translateProviderError` as `provider.auth_error` carrying the provider's
 * message instead of a misleading re-login prompt.
 *
 * Constructed by `ModelCatalog` (`catalogService.ts`) — plain constructor
 * args, no DI.
 */

import { AsyncEventQueue } from '#/_base/asyncEventQueue';
import type { VideoURLPart } from '#/kosong/contract/message';
import { APIStatusError, isAbortError } from '#/kosong/contract/errors';
import { generate, type GenerateResult } from '#/kosong/contract/generate';
import type {
  ChatProvider,
  GenerateOptions,
  ProviderRequestAuth,
  StreamDecodeStats,
  VideoUploadInput,
} from '#/kosong/contract/provider';
import { translateProviderError } from '#/kosong/protocol/errors';
import type { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';

import type { AuthProvider, Model } from './catalog';
import type { LLMCallParams, LLMEvent, LLMRequestInput, ModelRequester } from './modelRequester';

export class ModelRequesterImpl implements ModelRequester {
  private cachedChatProvider: ChatProvider | undefined;

  constructor(
    readonly model: Model,
    private readonly protocolRegistry: IProtocolAdapterRegistry,
  ) {}

  private resolveChatProvider(): ChatProvider {
    if (this.cachedChatProvider !== undefined) return this.cachedChatProvider;
    const model = this.model;
    this.cachedChatProvider = this.protocolRegistry.createChatProvider({
      protocol: model.protocol,
      providerType: model.providerType,
      baseUrl: model.baseUrl,
      modelName: model.name,
      defaultHeaders: model.headers,
      providerOptions: model.providerOptions,
    });
    return this.cachedChatProvider;
  }

  request(
    input: LLMRequestInput,
    signal?: AbortSignal,
    params?: LLMCallParams,
  ): AsyncIterable<LLMEvent> {
    const queue = new AsyncEventQueue<LLMEvent>();
    void this.runRequest(input, signal, queue, params).then(
      () => queue.end(),
      (error) => queue.fail(error),
    );
    return queue;
  }

  async uploadVideo(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart> {
    const provider = this.resolveChatProvider();
    if (provider.uploadVideo === undefined) {
      throw new Error(
        `Model "${this.model.id}" (protocol=${this.model.protocol}) does not support video upload`,
      );
    }
    const uploadVideo = provider.uploadVideo.bind(provider);
    return this.runWithAuthRefresh((auth) =>
      uploadVideo(input, { signal: options?.signal, auth }),
    );
  }

  private async runRequest(
    input: LLMRequestInput,
    signal: AbortSignal | undefined,
    queue: AsyncEventQueue<LLMEvent>,
    params?: LLMCallParams,
  ): Promise<void> {
    signal?.throwIfAborted();
    const provider = this.resolveChatProvider();

    let requestStartedAt = Date.now();
    let requestSentAt: number | undefined;
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    let decodeStats: StreamDecodeStats | undefined;
    let streamedAnyPart = false;

    const options: GenerateOptions = {
      signal,
      cacheKey: params?.cacheKey,
      sampling: params?.sampling,
      thinking:
        params?.thinkingEffort === undefined
          ? undefined
          : { effort: params.thinkingEffort, keep: params.thinkingKeep },
      maxCompletionTokens: params?.maxCompletionTokens,
      usedContextTokens: params?.usedContextTokens,
      maxContextTokens: params?.maxContextTokens,
      onRequestStart: () => {
        requestStartedAt = Date.now();
      },
      onRequestSent: () => {
        requestSentAt = Date.now();
      },
      onStreamEnd: (stats) => {
        streamEndedAt = Date.now();
        decodeStats = stats;
      },
      onTraceId: params?.onTraceId,
      responseFormat: input.responseFormat,
    };

    let result: GenerateResult;
    try {
      result = await this.runWithAuthRefresh((auth) => {
        requestStartedAt = Date.now();
        return generate(
          provider,
          input.systemPrompt,
          [...input.tools],
          [...input.messages],
          {
            onMessagePart: (part) => {
              firstChunkAt ??= Date.now();
              streamedAnyPart = true;
              queue.push({ type: 'part', part });
            },
          },
          { ...options, auth },
        );
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted === true) throw error;
      throw translateProviderError(error);
    }

    if (!streamedAnyPart) {
      for (const part of result.message.content) {
        firstChunkAt ??= Date.now();
        queue.push({ type: 'part', part });
      }
      for (const toolCall of result.message.toolCalls) {
        firstChunkAt ??= Date.now();
        queue.push({ type: 'part', part: toolCall });
      }
    }

    if (result.usage !== undefined && result.usage !== null) {
      queue.push({ type: 'usage', usage: result.usage, model: this.model.name });
    }
    queue.push({
      type: 'finish',
      message: result.message,
      providerFinishReason: result.finishReason ?? undefined,
      rawFinishReason: result.rawFinishReason ?? undefined,
      id: result.id ?? undefined,
      traceId: result.traceId ?? undefined,
    });
    if (firstChunkAt !== undefined) {
      queue.push({
        type: 'timing',
        ...buildStreamTiming(
          requestStartedAt,
          requestSentAt,
          firstChunkAt,
          streamEndedAt,
          decodeStats,
        ),
      });
    }
  }

  private async runWithAuthRefresh<T>(
    run: (auth: ProviderRequestAuth | undefined) => Promise<T>,
  ): Promise<T> {
    const auth = await this.authProvider.getAuth();
    try {
      return await run(auth);
    } catch (error) {
      if (!this.shouldForceRefresh(error)) throw error;
    }

    const refreshedAuth = await this.authProvider.getAuth({ force: true });
    try {
      return await run(refreshedAuth);
    } catch (error) {
      // A 401 that survives a forced token refresh means the provider rejected
      // the account itself: surface it as `provider.auth_error` (carrying the
      // provider's message) instead of a misleading re-login prompt.
      if (isUnauthorizedStatusError(error)) throw translateProviderError(error);
      throw error;
    }
  }

  private get authProvider(): AuthProvider {
    return this.model.authProvider;
  }

  private shouldForceRefresh(error: unknown): boolean {
    return this.authProvider.canRefresh === true && isUnauthorizedStatusError(error);
  }
}

function isUnauthorizedStatusError(error: unknown): error is APIStatusError {
  return error instanceof APIStatusError && error.statusCode === 401;
}

export function buildStreamTiming(
  requestStartedAt: number,
  requestSentAt: number | undefined,
  firstChunkAt: number,
  streamEndedAt: number | undefined,
  decodeStats: StreamDecodeStats | undefined,
): {
  firstTokenLatencyMs: number;
  streamDurationMs: number;
  requestBuildMs?: number;
  serverFirstTokenMs?: number;
  serverDecodeMs?: number;
  clientConsumeMs?: number;
} {
  const outputEndedAt = streamEndedAt ?? Date.now();
  const timing: {
    firstTokenLatencyMs: number;
    streamDurationMs: number;
    requestBuildMs?: number;
    serverFirstTokenMs?: number;
    serverDecodeMs?: number;
    clientConsumeMs?: number;
  } = {
    firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
    streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
  };
  if (requestSentAt !== undefined) {
    const sentAt = Math.min(Math.max(requestSentAt, requestStartedAt), firstChunkAt);
    timing.requestBuildMs = sentAt - requestStartedAt;
    timing.serverFirstTokenMs = firstChunkAt - sentAt;
  }
  if (decodeStats !== undefined) {
    timing.serverDecodeMs = Math.max(0, decodeStats.serverDecodeMs);
    timing.clientConsumeMs = Math.max(0, decodeStats.clientConsumeMs);
  }
  return timing;
}
