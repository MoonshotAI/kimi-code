/**
 * `kosong/model` domain — the `ModelRequester` contract: per-turn input,
 * streamed events, the per-turn intent carrier `ModelRequestParams`, and the
 * execution-only hooks in `ModelRequestOptions`.
 *
 * `ModelRequestParams` is how every per-turn intent reaches the wire: prompt-cache
 * key, sampling overrides, thinking effort/keep, and the completion-token
 * budget (with its window-clamp companions and explicit marker). It is
 * deliberately dialect-free —
 * each wire dialect encodes (or silently drops) an intent in its own hooks.
 * The requester maps the params onto `GenerateOptions` 1:1 and reports the
 * provider's final request observation through its event stream; the fixed
 * overlay order inside the bases is `cacheKey → sampling → thinking →
 * maxCompletionTokens`.
 */

import type { Message, StreamedMessagePart, VideoURLPart } from '#/kosong/contract/message';
import type {
  FinishReason,
  ProviderRequestObservation,
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
  | { readonly type: 'request'; readonly observation: ProviderRequestObservation }
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

export interface ModelRequestParams {
  readonly cacheKey?: string;
  readonly sampling?: SamplingOptions;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
  readonly maxCompletionTokensExplicit?: boolean;
  readonly usedContextTokens?: number;
  readonly maxContextTokens?: number;
}

export interface ModelRequestOptions extends ModelRequestParams {
  readonly onTraceId?: (traceId: string | null) => void;
}

export interface ModelRequester {
  readonly model: Model;

  request(
    input: ModelRequestInput,
    signal?: AbortSignal,
    options?: ModelRequestOptions,
  ): AsyncIterable<ModelRequestEvent>;

  uploadVideo?(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart>;
}
