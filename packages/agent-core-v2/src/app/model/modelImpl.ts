/**
 * `model` domain (L2) — `Model` god-object implementation.
 *
 * `ModelImpl` is the concrete `Model`. It is constructed by
 * `IModelResolver.resolve(...)` from Platform/Provider/Model config, closes
 * over the resolved `AuthProvider` and a lazily-built kosong `ChatProvider`,
 * and exposes `request(...)` — the driver that turns per-turn input
 * (systemPrompt / tools / messages) into a stream of `LLMEvent`s.
 *
 * The `with*` methods return **new wrapper instances** rather than mutating,
 * so callers can safely fork per-request overrides (thinking, generation
 * kwargs, completion-token cap) without disturbing the shared Model.
 *
 * kosong is the current stream driver — `.request()` delegates the actual
 * wire I/O to `IProtocolAdapterRegistry.createChatProvider(...)` + kosong's
 * `generate(...)`. Phase 8 replaces the wire with native adapters; only this
 * file changes.
 *
 * Provider error translation also lives here: a 401 that survives a forced
 * token refresh means the provider rejected the account itself, so it is
 * surfaced as `PROVIDER_AUTH_ERROR` carrying the provider's message instead
 * of a misleading re-login prompt.
 */

import { AsyncEventQueue } from '#/_base/asyncEventQueue';
import { isAbortError } from '#/_base/utils/abort';
import { type ModelCapability } from '#/app/llmProtocol/capability';
import { APIStatusError } from '#/app/llmProtocol/errors';
import { type GenerationKwargs } from '#/app/llmProtocol/kimiOptions';
import { type VideoURLPart } from '#/app/llmProtocol/message';
import { type GenerateCallbacks, type MaxCompletionTokensOptions, type ProviderRequestAuth, type StreamDecodeStats, type VideoUploadInput } from '#/app/llmProtocol/request';
import { type ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import type { ChatProvider } from '#/app/llmProtocol/provider';
import type { Protocol, ProtocolProviderOptions } from '#/app/protocol/protocol';
import { generate, type GenerateResult } from '#/app/llmProtocol/generate';
import { sanitizeStatusErrorMessage, translateProviderError } from '#/app/protocol/errors';
import { type ProtocolAdapterRegistry } from '#/app/protocol/protocolAdapterRegistry';
import { ErrorCodes, Error2 } from '#/errors';

import type { AuthProvider, LLMEvent, LLMRequestInput, Model } from './modelInstance';

export interface ModelImplInit {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly alwaysThinking: boolean;
  readonly providerName: string;
  readonly authProvider: AuthProvider;
  readonly protocolRegistry: ProtocolAdapterRegistry;
  readonly providerOptions?: ProtocolProviderOptions;
}

export class ModelImpl implements Model {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly authProvider: AuthProvider;
  readonly thinkingEffort: ThinkingEffort | null;
  readonly alwaysThinking: boolean;
  readonly providerName: string;

  private readonly protocolRegistry: ProtocolAdapterRegistry;
  private readonly providerOptions: ProtocolProviderOptions;

  private readonly transforms: readonly ((p: ChatProvider) => ChatProvider)[];
  private cachedChatProvider: ChatProvider | undefined;

  constructor(init: ModelImplInit, transforms: readonly ((p: ChatProvider) => ChatProvider)[] = []) {
    this.id = init.id;
    this.name = init.name;
    this.aliases = init.aliases;
    this.protocol = init.protocol;
    this.baseUrl = init.baseUrl;
    this.headers = init.headers;
    this.capabilities = init.capabilities;
    this.maxContextSize = init.maxContextSize;
    this.maxOutputSize = init.maxOutputSize;
    this.displayName = init.displayName;
    this.reasoningKey = init.reasoningKey;
    this.supportEfforts = init.supportEfforts;
    this.defaultEffort = init.defaultEffort;
    this.authProvider = init.authProvider;
    this.protocolRegistry = init.protocolRegistry;
    this.providerOptions = init.providerOptions ?? {};
    this.transforms = transforms;
    this.alwaysThinking = init.alwaysThinking;
    this.providerName = init.providerName;
    this.thinkingEffort = null;
  }

  private clone(
    transform: ((p: ChatProvider) => ChatProvider) | undefined,
    fieldOverride?: Partial<ModelImpl>,
    initOverride?: { readonly providerOptions?: ProtocolProviderOptions },
  ): Model {
    const next = new ModelImpl(
      {
        id: this.id,
        name: this.name,
        aliases: this.aliases,
        protocol: this.protocol,
        baseUrl: this.baseUrl,
        headers: this.headers,
        capabilities: this.capabilities,
        maxContextSize: this.maxContextSize,
        maxOutputSize: this.maxOutputSize,
        displayName: this.displayName,
        reasoningKey: this.reasoningKey,
        supportEfforts: this.supportEfforts,
        defaultEffort: this.defaultEffort,
        alwaysThinking: this.alwaysThinking,
        providerName: this.providerName,
        authProvider: this.authProvider,
        protocolRegistry: this.protocolRegistry,
        providerOptions: initOverride?.providerOptions ?? this.providerOptions,
      },
      transform === undefined ? this.transforms : [...this.transforms, transform],
    );
    if (fieldOverride !== undefined) {
      Object.assign(next, fieldOverride);
    }
    return next;
  }

  withThinking(effort: ThinkingEffort): Model {
    return this.clone((p) => p.withThinking(effort), { thinkingEffort: effort });
  }

  get maxCompletionTokens(): number | undefined {
    return this.resolveChatProvider().maxCompletionTokens;
  }

  withMaxCompletionTokens(n: number, options?: MaxCompletionTokensOptions): Model {
    return this.clone((p) =>
      p.withMaxCompletionTokens !== undefined ? p.withMaxCompletionTokens(n, options) : p,
    );
  }

  withGenerationKwargs(kwargs: GenerationKwargs): Model {
    return this.clone((p) => {
      const applied = (p as ChatProvider & {
        withGenerationKwargs?: (k: GenerationKwargs) => ChatProvider;
      }).withGenerationKwargs;
      return applied !== undefined ? applied.call(p, kwargs) : p;
    });
  }

  withProviderOptions(options: ProtocolProviderOptions): Model {
    return this.clone(undefined, undefined, {
      providerOptions: mergeProviderOptions(this.providerOptions, options),
    });
  }

  withThinkingKeep(keep: string): Model {
    return this.clone((p) => {
      const applied = (p as ChatProvider & {
        withThinkingKeep?: (k: string) => ChatProvider;
      }).withThinkingKeep;
      return applied !== undefined ? applied.call(p, keep) : p;
    });
  }

  private resolveChatProvider(): ChatProvider {
    if (this.cachedChatProvider !== undefined) return this.cachedChatProvider;
    let provider = this.protocolRegistry.createChatProvider({
      protocol: this.protocol,
      baseUrl: this.baseUrl,
      modelName: this.name,
      defaultHeaders: this.headers,
      providerOptions: this.providerOptions,
    });
    for (const transform of this.transforms) provider = transform(provider);
    this.cachedChatProvider = provider;
    return provider;
  }

  request(input: LLMRequestInput, signal?: AbortSignal): AsyncIterable<LLMEvent> {
    const queue = new AsyncEventQueue<LLMEvent>();
    void this.runRequest(input, signal, queue).then(
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
        `Model "${this.id}" (protocol=${this.protocol}) does not support video upload`,
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
  ): Promise<void> {
    signal?.throwIfAborted();
    const provider = this.resolveChatProvider();

    let requestStartedAt = Date.now();
    let requestSentAt: number | undefined;
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    let decodeStats: StreamDecodeStats | undefined;
    let streamedAnyPart = false;

    const callbacks: GenerateCallbacks = {
      onMessagePart: (part) => {
        firstChunkAt ??= Date.now();
        streamedAnyPart = true;
        queue.push({ type: 'part', part });
      },
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
          callbacks,
          {
            signal,
            auth,
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
            responseFormat: input.responseFormat,
          },
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
      queue.push({ type: 'usage', usage: result.usage, model: this.name });
    }
    queue.push({
      type: 'finish',
      message: result.message,
      providerFinishReason: result.finishReason ?? undefined,
      rawFinishReason: result.rawFinishReason ?? undefined,
      id: result.id ?? undefined,
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
      if (isUnauthorizedStatusError(error)) throw toProviderAuthError(error);
      throw error;
    }
  }

  private shouldForceRefresh(error: unknown): boolean {
    return this.authProvider.canRefresh === true && isUnauthorizedStatusError(error);
  }
}

function isUnauthorizedStatusError(error: unknown): error is APIStatusError {
  return error instanceof APIStatusError && error.statusCode === 401;
}

function toProviderAuthError(error: APIStatusError): Error2 {
  const reason = sanitizeStatusErrorMessage(error.message);
  return new Error2(
    ErrorCodes.PROVIDER_AUTH_ERROR,
    reason.length > 0 ? reason : 'OAuth provider credentials were rejected.',
    {
      name: error.name,
      cause: error,
      details: {
        statusCode: error.statusCode,
        requestId: error.requestId,
      },
    },
  );
}

function mergeProviderOptions(
  base: ProtocolProviderOptions,
  next: ProtocolProviderOptions,
): ProtocolProviderOptions {
  return {
    ...base,
    ...next,
    metadata:
      base.metadata === undefined && next.metadata === undefined
        ? undefined
        : { ...base.metadata, ...next.metadata },
  };
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

export class StaticAuthProvider implements AuthProvider {
  readonly canRefresh = false;

  constructor(private readonly apiKey: string | undefined) {}
  async getAuth(): Promise<ProviderRequestAuth | undefined> {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) return undefined;
    return { apiKey: this.apiKey };
  }
}
