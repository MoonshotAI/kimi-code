/**
 * `kosong/model` domain (L2) — the `ModelRequester` contract: per-turn input,
 * streamed events, and the per-turn intent carrier `ModelRequestParams`.
 *
 * `ModelRequestParams` is how every per-turn intent reaches the wire: prompt-cache
 * key, sampling overrides, thinking effort/keep, and the completion-token
 * budget (with its window-clamp companions). It is deliberately dialect-free —
 * each wire dialect encodes (or silently drops) an intent in its own hooks.
 * The requester maps the params onto `GenerateOptions` 1:1; the fixed overlay
 * order inside the bases is `cacheKey → sampling → thinking →
 * maxCompletionTokens`.
 */

import type { Message, StreamedMessagePart, VideoURLPart } from '#/kosong/contract/message';
import type {
  FinishReason,
  ResponseFormat,
  SamplingOptions,
  ThinkingEffort,
  VideoUploadInput,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

import type { Model } from './catalog';

export interface ModelRequestInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly responseFormat?: ResponseFormat;
}

export interface ModelRequestTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  readonly requestBuildMs?: number;
  readonly serverFirstTokenMs?: number;
  readonly serverDecodeMs?: number;
  readonly clientConsumeMs?: number;
}

export type ModelRequestEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      readonly message: Message;
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
      readonly id?: string;
      readonly traceId?: string;
    }
  | ({ readonly type: 'timing' } & ModelRequestTiming);

/**
 * Per-turn intent for one `ModelRequester.request(...)`. Every field is
 * optional; an absent field simply does not reach the wire.
 */
export interface ModelRequestParams {
  /**
   * Prompt-cache key for this turn (typically derived from the session id).
   * Each dialect encodes it (`prompt_cache_key`, `metadata.user_id`) or
   * silently drops it.
   */
  readonly cacheKey?: string;
  /** Per-turn sampling overrides. */
  readonly sampling?: SamplingOptions;
  /** Per-turn thinking effort. */
  readonly thinkingEffort?: ThinkingEffort;
  /** Whether prior reasoning should be replayed (e.g. `'all'`). */
  readonly thinkingKeep?: string;
  /**
   * Per-turn completion-token budget (already folded through
   * `computeCompletionBudgetCap`). The base clamps it against the context
   * window before any dialect ceiling applies.
   */
  readonly maxCompletionTokens?: number;
  /**
   * Tokens already used in the context window, for the window clamp. Passed
   * ONLY when the caller did not explicitly override the request messages —
   * with explicit messages the budget is not tightened against the current
   * context (load-bearing rule, see the refactor plan).
   */
  readonly usedContextTokens?: number;
  /** Total context-window size, for the window clamp. */
  readonly maxContextTokens?: number;
  /**
   * Called as soon as the response headers arrive (before the stream body),
   * with the provider's trace id — `null` when the protocol has none.
   */
  readonly onTraceId?: (traceId: string | null) => void;
}

export interface ModelRequester {
  /** The pure-data Model this requester executes against. */
  readonly model: Model;

  request(
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ): AsyncIterable<ModelRequestEvent>;

  uploadVideo?(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart>;
}

/**
 * The completion-token ceiling that actually applies to a call, computed from
 * the params alone (the requester folds the budget into params up front, so
 * recording code never has to read provider state back).
 */
export function effectiveMaxCompletionTokens(params?: ModelRequestParams): number | undefined {
  return params?.maxCompletionTokens;
}
