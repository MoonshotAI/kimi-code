import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { MediaLowerPorts } from '#/llm/media/materialize';
import type { Message, StreamedMessagePart, ToolDescription } from '#/llm/message';
import type { LlmModel, ResponseFormat } from '#/llm/model';
import type { ThinkingRequestOptions } from '#/llm/thinking';
import type {
  LlmRequestConfig,
  LlmRequestContent,
  LlmSampling,
} from '#/llm/requester/requester';
import type { FinishInfo, TokenUsage } from '#/llm/usage';

export interface FormatRequestInput {
  readonly model: LlmModel;
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
  readonly thinking?: ThinkingRequestOptions;
  readonly responseFormat?: ResponseFormat;
  readonly maxCompletionTokens?: number;
  readonly cacheKey?: string;
  readonly sampling?: LlmSampling;
  readonly media?: MediaLowerPorts;
  readonly signal?: AbortSignal;
}

export function formatRequestInput(
  config: LlmRequestConfig,
  content: LlmRequestContent,
  overrides?: {
    readonly model?: LlmModel;
    readonly messages?: readonly Message[];
    readonly media?: MediaLowerPorts;
    readonly signal?: AbortSignal;
  },
): FormatRequestInput {
  return {
    model: overrides?.model ?? config.model,
    thinking: config.thinking,
    responseFormat: config.responseFormat,
    maxCompletionTokens: config.maxCompletionTokens,
    cacheKey: config.cacheKey,
    sampling: config.sampling,
    systemPrompt: content.systemPrompt,
    messages: overrides?.messages ?? content.messages,
    tools: content.tools ?? [],
    media: overrides?.media ?? content.media,
    signal: overrides?.signal,
  };
}

export function resolveMaxCompletionCap(input: FormatRequestInput): number | undefined {
  if (input.maxCompletionTokens === undefined) {
    return undefined;
  }
  return Math.max(1, input.maxCompletionTokens);
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
