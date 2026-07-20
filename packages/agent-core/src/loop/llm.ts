/**
 * LLM contract for the model capability used by the stateless loop.
 *
 * The immutable `LLM` object owns provider/model metadata, capability metadata,
 * and the system prompt. Other host concerns are injected through separate
 * surfaces.
 */

import type {
  FinishReason,
  Message,
  ModelCapability,
  TextPart,
  ThinkPart,
  TokenUsage,
  Tool,
  ToolCall,
} from '@moonshot-ai/kosong';

export interface ToolCallDelta {
  readonly toolCallId: string;
  readonly name?: string | undefined;
  readonly argumentsPart?: string | undefined;
}

/**
 * Request-scoped side channel from the host layers (loop, LLM adapter,
 * compaction) down to the `Agent.generate` choke point, consumed there by the
 * diagnostic logger and the wire-record request trace.
 */
export interface LLMRequestLogFields {
  readonly turnStep?: string;
  readonly attempt?: string;
  /** Request purpose; absent means a regular loop step. */
  readonly kind?: 'loop' | 'compaction';
  /** Set when the messages are a fallback resend projection: the strict
   * wire-compliant rebuild, the media-degraded rebuild after a
   * request-too-large rejection, or the media-stripped rebuild after an
   * image-format rejection / a second request-too-large rejection. */
  readonly projection?: 'strict' | 'media-degraded' | 'media-stripped';
  /** Compaction only: messages dropped so far by overflow/empty shrinking. */
  readonly droppedCount?: number;
}

export interface LLMStreamTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  /**
   * Portion of `firstTokenLatencyMs` spent in-process building the request
   * (message serialization, param assembly) before the provider dispatched the
   * network call. `undefined` when the provider does not report the
   * client/server boundary (no `onRequestSent`).
   */
  readonly requestBuildMs?: number;
  /**
   * Portion of `firstTokenLatencyMs` spent waiting on the network + API server
   * from request dispatch to the first streamed token. `undefined` when the
   * provider does not report the client/server boundary.
   */
  readonly serverFirstTokenMs?: number;
  /**
   * Split of `streamDurationMs` (the decode window): time spent awaiting parts
   * from the provider (`serverDecodeMs`, server + network) vs. time spent
   * processing parts in-process (`clientConsumeMs`, host callbacks / merge).
   * `undefined` when the provider stream did not report decode accounting.
   */
  readonly serverDecodeMs?: number;
  readonly clientConsumeMs?: number;
}

export interface LLMRequestTrace {
  readonly traceId: string | undefined;
}

export class LLMRequestTraceState implements LLMRequestTrace {
  traceId: string | undefined;

  reset(): void {
    this.traceId = undefined;
  }

  capture(traceId: string | null | undefined): void {
    this.traceId = traceId ?? undefined;
  }
}

export interface LLMChatParams {
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  requestLogFields?: LLMRequestLogFields;
  onTextDelta?: ((delta: string) => void) | undefined;
  onThinkDelta?: ((delta: string) => void) | undefined;
  onToolCallDelta?: ((delta: ToolCallDelta) => void) | undefined;
  /**
   * Fires once per completed text block. Additive relative to
   * `onTextDelta` — deltas still fire chunk-by-chunk for UI streaming.
   * Returned promises are awaited by the adapter to preserve transcript append
   * order. Durable transcript writes receive completed blocks only.
   */
  onTextPart?: ((part: TextPart) => Promise<void> | void) | undefined;
  /**
   * Fires once per completed thinking block. Additive relative to
   * `onThinkDelta` — deltas still fire chunk-by-chunk for UI streaming.
   * Returned promises are awaited by the adapter to preserve transcript append
   * order. Durable transcript writes receive completed blocks only.
   */
  onThinkPart?: ((part: ThinkPart) => Promise<void> | void) | undefined;
  trace?: LLMRequestTraceState;
}

export interface LLMChatResponse {
  toolCalls: ToolCall[];
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  messageId?: string;
  usage: TokenUsage;
  streamTiming?: LLMStreamTiming;
  /** Provider trace identifier from the `x-trace-id` response header (Kimi/KFC only). */
  traceId?: string;
}

export interface LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;
  isRetryableError?(error: unknown): boolean;
  chat(params: LLMChatParams): Promise<LLMChatResponse>;
}
