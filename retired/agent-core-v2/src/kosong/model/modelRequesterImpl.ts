/**
 * `kosong/model` domain (L2) — `ModelRequesterImpl`, the request executor.
 *
 * This is the ONLY production code that calls
 * `IProtocolAdapterRegistry.createChatProvider`: it lazily composes exactly
 * one immutable ChatProvider per Model (on first use) and caches it for the
 * Model's lifetime; every per-turn variation arrives as `ModelRequestParams` and
 * is mapped onto `GenerateOptions` (overlay order inside the bases:
 * `cacheKey → sampling → thinking → maxCompletionTokens`).
 *
 * The driver itself turns per-turn input (systemPrompt / tools / messages)
 * into the `ModelRequestEvent` stream via the contract's `generate(...)`, measures
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
import { APIStatusError, isAbortError, VideoUploadUnsupportedError } from '#/kosong/contract/errors';
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
import type {
  ModelRequestEvent,
  ModelRequestInput,
  ModelRequestParams,
  ModelRequester,
  ModelRequestTiming,
} from './modelRequester';

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
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ): AsyncIterable<ModelRequestEvent> {
    const queue = new AsyncEventQueue<ModelRequestEvent>();
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
      throw new VideoUploadUnsupportedError(
        `Model "${this.model.id}" (protocol=${this.model.protocol}) does not support video upload`,
      );
    }
    const uploadVideo = provider.uploadVideo.bind(provider);
    return this.runWithAuthRefresh((auth) =>
      uploadVideo(input, { signal: options?.signal, auth }),
    );
  }

  private async runRequest(
    input: ModelRequestInput,
    signal: AbortSignal | undefined,
    queue: AsyncEventQueue<ModelRequestEvent>,
    params?: ModelRequestParams,
  ): Promise<void> {
    signal?.throwIfAborted();
    const provider = this.resolveChatProvider();

    let requestStartedAt = Date.now();
    let requestSentAt: number | undefined;
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    let decodeStats: StreamDecodeStats | undefined;

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

    // Every content/tool-call part already arrived through `onMessagePart`:
    // the contract's `generate()` fires the callback for each part before
    // merging it into the result message and throws `APIEmptyResponseError`
    // on an empty stream, so there is nothing to backfill from
    // `result.message` here — only stream-absent metadata remains.
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

/** Writable view of `ModelRequestTiming`, used to build the timing incrementally. */
type MutableModelRequestTiming = { -readonly [K in keyof ModelRequestTiming]: ModelRequestTiming[K] };

export function buildStreamTiming(
  requestStartedAt: number,
  requestSentAt: number | undefined,
  firstChunkAt: number,
  streamEndedAt: number | undefined,
  decodeStats: StreamDecodeStats | undefined,
): ModelRequestTiming {
  const outputEndedAt = streamEndedAt ?? Date.now();
  const timing: MutableModelRequestTiming = {
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
