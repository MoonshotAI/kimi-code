import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { FinishInfo } from '#/llm/finish-reason';
import type { Message, StreamedMessagePart, ToolDescription } from '#/llm/message';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import type { TokenUsage } from '#/llm/usage';

export type FormatRequestInput = LlmRequestConfig & {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
  readonly usedContextTokens?: number;
};

export function resolveMaxCompletionCap(input: FormatRequestInput): number | undefined {
  const { maxCompletionTokens, usedContextTokens, maxContextTokens } = input;
  if (maxCompletionTokens === undefined) {
    return undefined;
  }
  let cap = maxCompletionTokens;
  if (
    usedContextTokens !== undefined &&
    maxContextTokens !== undefined &&
    maxContextTokens > 0
  ) {
    cap = Math.min(cap, maxContextTokens - usedContextTokens);
  }
  return Math.max(1, cap);
}

export interface StreamParseSink {
  onDelta(part: StreamedMessagePart): void;
  onFinish(finish: FinishInfo): void;
  onMessageId?(messageId: string): void;
  onUsage?(usage: Partial<TokenUsage>): void;
  onError?(message: LlmRemoteErrorMessage): void;
}

export interface StreamParserOptions<TChunk> {
  resolveUsage?(
    chunk: TChunk,
    defaultUsage: Partial<TokenUsage> | undefined,
  ): Partial<TokenUsage> | undefined;
}

export type StreamParser<TChunk = unknown> = (
  chunk: TChunk,
  sink: StreamParseSink,
) => void;

export interface ProtocolFormat<TChunk = unknown> {
  createStreamParser(options?: StreamParserOptions<TChunk>): StreamParser<TChunk>;
}
