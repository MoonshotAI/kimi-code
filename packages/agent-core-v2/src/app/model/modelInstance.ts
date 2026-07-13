/**
 * `model` domain (L2) — `Model` god-object contract.
 *
 * A `Model` is the runtime object the rest of v2 requests inference against.
 * It is self-contained: endpoint, resolved auth closure, protocol, wire-facing
 * model name, headers, capability matrix, budget knobs, and the `request()`
 * driver are all held on the instance. Callers supply only what varies per
 * turn — `systemPrompt`, `tools`, `messages`, and an `AbortSignal`.
 *
 * `IModelResolver.resolve(id)` is the sole factory: it reads the Model /
 * Provider / Platform records from `config` and returns a runnable instance.
 * Model is immutable at the field level; `withThinking(...)` and the other
 * `with*` methods return a new Model wrapper without mutating the original.
 *
 * The god-object shape is what enables the Platform × Protocol × Provider
 * decomposition — those three domains are purely construction-time metadata
 * sources; the running system only ever sees Models.
 */

import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { FinishReason } from '#/app/llmProtocol/finishReason';
import type { GenerationKwargs } from '#/app/llmProtocol/kimiOptions';
import type { Message, StreamedMessagePart, VideoURLPart } from '#/app/llmProtocol/message';
import type { ResponseFormat } from '#/app/llmProtocol/provider';
import type { MaxCompletionTokensOptions, ProviderRequestAuth, VideoUploadInput } from '#/app/llmProtocol/request';
import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import type { Tool } from '#/app/llmProtocol/tool';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import type { Protocol, ProtocolProviderOptions } from '#/app/protocol/protocol';

/**
 * Closure that produces a fresh `ProviderRequestAuth` on demand. Wraps an
 * OAuth token provider (with force-refresh on 401) or a static API key.
 * Reading it always returns the current material — callers must not cache.
 */
export interface AuthProvider {
  /** Whether this auth source can force-refresh credentials after an upstream 401. */
  readonly canRefresh?: boolean;

  /**
   * Get a `ProviderRequestAuth` for the next request. Returns `undefined`
   * when no auth material is available (anonymous endpoint, or the caller
   * passes secrets via `apiKey` directly on the config).
   */
  getAuth(options?: { readonly force?: boolean }): Promise<ProviderRequestAuth | undefined>;
}

/** Per-request input for `Model.request(...)`. */
export interface LLMRequestInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly responseFormat?: ResponseFormat;
}

/**
 * Streamed events emitted by `Model.request(...)`. `part` carries incremental
 * content / tool-call fragments; `usage` and `finish` are terminal signals;
 * `timing` reports request-level latency when available.
 */
export type LLMEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      /** Fully-assembled assistant message for this request. */
      readonly message: Message;
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
      readonly id?: string;
    }
  | {
      readonly type: 'timing';
      readonly firstTokenLatencyMs: number;
      readonly streamDurationMs: number;
      readonly requestBuildMs?: number;
      readonly serverFirstTokenMs?: number;
      readonly serverDecodeMs?: number;
      readonly clientConsumeMs?: number;
    };

export interface Model {
  /** Globally-unique Model id (the key in `[models.<id>]`). */
  readonly id: string;
  /** Wire-facing model name sent to the endpoint. Required, per Phase 2 (e). */
  readonly name: string;
  /** Free-form routing aliases; a name-based lookup matches these. */
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;

  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly thinkingEffort: ThinkingEffort | null;
  readonly maxCompletionTokens?: number;
  /**
   * True when this Model's capabilities include `always_thinking` — the
   * runtime should force a thinking pass even if the user's requested
   * `thinkingLevel` is `off`.
   */
  readonly alwaysThinking: boolean;
  /**
   * The config-side Provider id this Model resolves against (the entry in
   * `[providers.*]`). For flat-case Models, this is the origin derived from
   * `baseUrl` (e.g. `api.openai.com`).
   */
  readonly providerName: string;

  /**
   * Fresh auth material for every request. The Model closes over the
   * resolved `AuthProvider` so callers never handle raw tokens.
   */
  readonly authProvider: AuthProvider;

  /** Return a new Model wrapper with the given thinking effort applied. */
  withThinking(effort: ThinkingEffort): Model;

  /** Return a new Model wrapper with a completion-token cap applied. */
  withMaxCompletionTokens(n: number, options?: MaxCompletionTokensOptions): Model;

  /** Return a new Model wrapper with additional generation kwargs applied. */
  withGenerationKwargs(kwargs: GenerationKwargs): Model;

  /** Return a new Model wrapper with additional protocol-constructor options applied. */
  withProviderOptions(options: ProtocolProviderOptions): Model;

  withThinkingKeep(keep: string): Model;

  /**
   * Drive one LLM request end-to-end. Streams `LLMEvent`s until the stream
   * terminates (either normally with `usage`+`finish`, or with an error).
   * Cancellation is via the optional `AbortSignal`.
   */
  request(input: LLMRequestInput, signal?: AbortSignal): AsyncIterable<LLMEvent>;

  /**
   * Upload a video for multi-modal input. Present only when the underlying
   * protocol adapter supports it (currently Kimi). Callers should feature-
   * detect via `capabilities.video_in`.
   */
  uploadVideo?(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart>;
}
