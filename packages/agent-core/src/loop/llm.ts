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

export interface LLMRequestLogContext {
  readonly turnId?: string;
  readonly step?: number;
  readonly stepUuid?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
}

export interface LLMStreamTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
}

export interface LLMChatParams {
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  requestLogContext?: LLMRequestLogContext;
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
