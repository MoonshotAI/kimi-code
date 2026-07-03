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

export interface LLMRequestLogFields {
  readonly turnStep: string;
  readonly attempt?: string;
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
}

export interface LLMChatResponse {
  toolCalls: ToolCall[];
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  usage: TokenUsage;
  streamTiming?: LLMStreamTiming;
}

export interface LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;
  isRetryableError?(error: unknown): boolean;
  chat(params: LLMChatParams): Promise<LLMChatResponse>;
}
