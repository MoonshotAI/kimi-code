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
 */

import { AsyncEventQueue } from '#/_base/asyncEventQueue';
import type {
  GenerateCallbacks,
  GenerationKwargs,
  MaxCompletionTokensOptions,
  ModelCapability,
  ProviderRequestAuth,
  StreamDecodeStats,
  ThinkingEffort,
  VideoUploadInput,
  VideoURLPart,
} from '#/app/llmProtocol';
import type { ChatProvider, Protocol } from '#/app/protocol';
import { generate } from '#/app/protocol';
import { type ProtocolAdapterRegistry } from '#/app/protocol/protocolAdapterRegistry';

import type { AuthProvider, LLMEvent, LLMRequestInput, Model } from './modelInstance';

export interface ModelImplInit {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly alwaysThinking: boolean;
  readonly providerName: string;
  readonly authProvider: AuthProvider;
  readonly protocolRegistry: ProtocolAdapterRegistry;
  /** Extra kosong-shaped config passed through when constructing the wire adapter. */
  readonly extras?: Readonly<Record<string, unknown>>;
}

export class ModelImpl implements Model {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly authProvider: AuthProvider;
  readonly thinkingEffort: ThinkingEffort | null;
  readonly alwaysThinking: boolean;
  readonly providerName: string;

  private readonly protocolRegistry: ProtocolAdapterRegistry;
  private readonly extras: Readonly<Record<string, unknown>>;

  /**
   * Chain of transforms applied to the raw kosong `ChatProvider` before use.
   * `withThinking` / `withMaxCompletionTokens` / `withGenerationKwargs`
   * append to this chain; the actual `ChatProvider` is materialized lazily
   * on the first `.request()` and cached.
   */
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
    this.authProvider = init.authProvider;
    this.protocolRegistry = init.protocolRegistry;
    this.extras = init.extras ?? {};
    this.transforms = transforms;
    this.alwaysThinking = init.alwaysThinking;
    this.providerName = init.providerName;
    // thinkingEffort is materialized via `withThinking` — the transform chain
    // owns the actual value applied to the underlying ChatProvider; we track
    // the most recent effort on the wrapper so callers can inspect it.
    this.thinkingEffort = null;
  }

  private clone(
    transform: (p: ChatProvider) => ChatProvider,
    fieldOverride?: Partial<ModelImpl>,
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
        alwaysThinking: this.alwaysThinking,
        providerName: this.providerName,
        authProvider: this.authProvider,
        protocolRegistry: this.protocolRegistry,
        extras: this.extras,
      },
      [...this.transforms, transform],
    );
    if (fieldOverride !== undefined) {
      Object.assign(next, fieldOverride);
    }
    return next;
  }

  withThinking(effort: ThinkingEffort): Model {
    return this.clone((p) => p.withThinking(effort), { thinkingEffort: effort });
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

  /** Materialize the transformed kosong ChatProvider. Cached per Model instance. */
  private resolveChatProvider(): ChatProvider {
    if (this.cachedChatProvider !== undefined) return this.cachedChatProvider;
    let provider = this.protocolRegistry.createChatProvider({
      protocol: this.protocol,
      baseUrl: this.baseUrl,
      modelName: this.name,
      customHeaders: this.headers,
      extras: this.extras,
    });
    for (const transform of this.transforms) provider = transform(provider);
    this.cachedChatProvider = provider;
    return provider;
  }

  request(input: LLMRequestInput, signal?: AbortSignal): AsyncIterable<LLMEvent> {
    const queue = new AsyncEventQueue<LLMEvent>();
    void this.runRequest(input, signal, queue).then(
      () => queue.end(),
      (err) => queue.fail(err),
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
    return provider.uploadVideo(input, { signal: options?.signal });
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

    const auth = await this.authProvider.getAuth();
    requestStartedAt = Date.now();

    const result = await generate(
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
      },
    );

    // Non-streaming providers still populate `result.message.content`;
    // surface those parts so downstream consumers see the content.
    if (!streamedAnyPart) {
      for (const part of result.message.content) {
        firstChunkAt ??= Date.now();
        queue.push({ type: 'part', part });
      }
    }

    if (result.usage !== undefined && result.usage !== null) {
      queue.push({ type: 'usage', usage: result.usage, model: this.name });
    }
    queue.push({
      type: 'finish',
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

/**
 * Simple bearer/api-key AuthProvider suitable for the flat-Model case.
 * Wraps a static or provider-backed token retriever with optional force-
 * refresh semantics.
 */
export class StaticAuthProvider implements AuthProvider {
  constructor(private readonly apiKey: string | undefined) {}
  async getAuth(): Promise<ProviderRequestAuth | undefined> {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) return undefined;
    // kosong's provider adapters read the bearer/api token from `apiKey`
    // (see `requireProviderApiKey`); a headers-only shape is rejected.
    return { apiKey: this.apiKey };
  }
}
