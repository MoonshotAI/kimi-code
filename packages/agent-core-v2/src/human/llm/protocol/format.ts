import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { FinishInfo } from '#/llm/finish-reason';
import type { ProtocolTrait, TraitContext } from '#/llm/protocol/trait';
import type { Message, StreamedMessagePart, ToolDescription } from '#/llm/message';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import type { TokenUsage } from '#/llm/usage';

export type FormatRequestInput = LlmRequestConfig & {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
  readonly usedContextTokens?: number;
  readonly trait: ProtocolTrait | undefined;
  readonly ctx: TraitContext;
};

export interface FormatRequestOptions {
  readonly reasoningKey?: string;
}

export interface StreamParseSink {
  onDelta(part: StreamedMessagePart): void;
  onFinish(finish: FinishInfo): void;
  onMessageId?(messageId: string): void;
  onUsage?(usage: Partial<TokenUsage>): void;
  onError?(message: LlmRemoteErrorMessage): void;
}

export type StreamParser<TChunk = unknown> = (chunk: TChunk, sink: StreamParseSink) => void;

export interface StreamParserOptions {
  readonly trait?: ProtocolTrait;
  readonly ctx: TraitContext;
}

export interface ProtocolFormat<
  TRequest = Record<string, unknown>,
  _TResponse = unknown,
  TChunk = unknown,
> {
  formatRequest(input: FormatRequestInput, options?: FormatRequestOptions): TRequest;
  createStreamParser(options?: StreamParserOptions): StreamParser<TChunk>;
}
