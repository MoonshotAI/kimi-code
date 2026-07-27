/**
 * `kosong/contract` domain (L0) — the ChatProvider wire contract.
 *
 * ⚠ Named `provider` but this is the L0 contract, not an implementation:
 * the slimmed `ChatProvider` interface plus everything a single generation
 * call needs. Two invariants hold here:
 *
 *  - A ChatProvider is immutable after construction. The interface has no
 *    `with*` methods; every per-turn intent (prompt-cache key, sampling
 *    overrides, thinking effort/keep, completion-token budget) flows through
 *    `GenerateOptions` on each `generate` call instead of through morphs.
 *  - `GenerateOptions` is the per-turn intent carrier. Each wire dialect
 *    decides how — or whether — to encode an intent (e.g. a cache key may
 *    become `prompt_cache_key`, `metadata.user_id`, or be silently dropped).
 *
 * Pure types only — no other domain, no I/O, no SDKs.
 */

import type { Message, StreamedMessagePart, VideoURLPart } from './message';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

/**
 * Thinking effort requested for one generation.
 *
 * `'off'` and `'on'` are local control signals. Other strings are concrete
 * model effort values. Protocol adapters receive an already-resolved value
 * and preserve concrete efforts when their upstream protocol has a native
 * field.
 */
export type ThinkingEffort = 'off' | 'on' | (string & {});

export type JsonSchemaObject = Record<string, unknown>;

export interface JsonObjectResponseFormat {
  readonly type: 'json_object';
}

export interface JsonSchemaResponseFormat {
  readonly type: 'json_schema';
  readonly jsonSchema: {
    readonly name: string;
    readonly schema: JsonSchemaObject;
    readonly strict?: boolean;
    readonly description?: string;
  };
}

export type ResponseFormat = JsonObjectResponseFormat | JsonSchemaResponseFormat;

export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

export interface StreamedMessage {
  [Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart>;
  readonly id: string | null;
  readonly usage: TokenUsage | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
  /**
   * Trace id from the provider's `x-trace-id` response header (Kimi only;
   * `null` for every other protocol and for headerless responses).
   */
  readonly traceId?: string | null;
}

export interface ProviderRequestAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * Per-turn sampling overrides. Intent, not wire: each dialect maps these to
 * its own parameter names (`temperature` / `top_p` on OpenAI-style wires).
 */
export interface SamplingOptions {
  readonly temperature?: number;
  readonly topP?: number;
}

/**
 * Per-turn thinking intent: how hard the model should reason, and whether
 * prior reasoning should be replayed (`keep`, e.g. `'all'`). Each dialect
 * encodes the pair in its own shape (`reasoning_effort`,
 * `extra_body.thinking`, `thinking: {type:'enabled'}` + effort, …).
 */
export interface ThinkingRequestOptions {
  readonly effort: ThinkingEffort;
  readonly keep?: string;
}

/**
 * How a wire dialect rewrites tool-call ids before sending (length ceilings,
 * character whitelists). Implementations live in the bases; only the shape
 * is contract.
 */
export interface ToolCallIdPolicy {
  normalize: (id: string) => string;
  maxLength?: number;
}

export interface StreamDecodeStats {
  readonly serverDecodeMs: number;
  readonly clientConsumeMs: number;
}

export interface VideoUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string | undefined;
}

/**
 * Per-call settings for one `ChatProvider.generate(...)`: the abort signal
 * and request auth, the per-turn intent fields, and the instrumentation
 * callbacks the caller wires up.
 *
 * Intent fields are consumed by the provider in a fixed overlay order —
 * `cacheKey` → `sampling` → `thinking` → `maxCompletionTokens` — so a
 * dialect hook always sees the kwargs seeded by the intents before it.
 */
export interface GenerateOptions {
  signal?: AbortSignal;
  auth?: ProviderRequestAuth;
  responseFormat?: ResponseFormat;
  /**
   * Prompt-cache key for this turn (typically derived from the session id).
   * Each dialect encodes it (`prompt_cache_key`, `metadata.user_id`) or
   * silently drops it.
   */
  cacheKey?: string;
  /** Per-turn sampling overrides. */
  sampling?: SamplingOptions;
  /** Per-turn thinking intent (effort + keep). */
  thinking?: ThinkingRequestOptions;
  /**
   * Per-turn completion-token budget. The base clamps it against the context
   * window (`maxContextTokens - usedContextTokens`, floor 1) before any
   * dialect ceiling applies.
   */
  maxCompletionTokens?: number;
  /** Tokens already used in the context window, for the window clamp. */
  usedContextTokens?: number;
  /** Total context-window size, for the window clamp. */
  maxContextTokens?: number;
  onRequestStart?: () => void;
  onRequestSent?: () => void;
  onStreamEnd?: (stats?: StreamDecodeStats) => void;
  /**
   * Called as soon as the response headers arrive (before the stream body),
   * with the provider's trace id — `null` when the protocol has none.
   */
  onTraceId?: (traceId: string | null) => void;
}

/**
 * A constructed, immutable wire adapter. All construction-time variation
 * (endpoint, credentials, dialect hooks) is baked in by the factory; all
 * per-turn variation arrives via `GenerateOptions`.
 */
export interface ChatProvider {
  readonly name: string;
  readonly modelName: string;
  /** Construction-time thinking default; per-turn intent overrides it. */
  readonly thinkingEffort: ThinkingEffort | null;
  /** Construction-time completion-token ceiling, when configured. */
  readonly maxCompletionTokens?: number;
  generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage>;
  uploadVideo?(input: string | VideoUploadInput, options?: GenerateOptions): Promise<VideoURLPart>;
}
