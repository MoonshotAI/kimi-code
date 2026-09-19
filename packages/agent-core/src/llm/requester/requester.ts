import type { LlmErrorMessage, LlmRemoteErrorMessage } from '#/llm/errors';
import type { MediaLowerPorts } from '#/llm/media/materialize';
import type {
  Message,
  StreamedMessagePart,
  ToolDescription,
} from '#/llm/message';
import type { LlmModel, ResponseFormat } from '#/llm/model';
import type { ThinkingRequestOptions } from '#/llm/thinking';
import type { FinishInfo, TokenUsage } from '#/llm/usage';

export interface ToolCallIdPolicy {
  normalize: (id: string) => string;
  maxLength?: number;
}

export type LlmErrorClassifier = (error: unknown) => LlmRemoteErrorMessage | undefined;

export type LlmRequestEvent =
  | { type: 'llm.sent' }
  | { type: 'llm.streaming.headers'; headers: Record<string, string> }
  | { type: 'llm.streaming.part'; part: StreamedMessagePart }
  | { type: 'llm.streaming.usage'; usage: Partial<TokenUsage> }
  | { type: 'llm.streaming.finish'; finish: FinishInfo }
  | { type: 'llm.streaming.message_id'; messageId: string }
  | { type: 'llm.failed.syntax'; error: LlmErrorMessage<'syntax'> }
  | { type: 'llm.failed.remote'; error: LlmRemoteErrorMessage; rawError?: unknown }
  | { type: 'llm.done' };

export type ToolMessageConversion = 'extract_text' | 'keep_parts';

export interface LlmCredential {
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
}

export interface LlmCredentialProvider {
  resolve(): Promise<LlmCredential | undefined> | LlmCredential | undefined;
  canRecover?(error: unknown): boolean;
  invalidate?(): void;
}

export interface LlmSampling {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stop?: readonly string[];
  readonly seed?: number;
  readonly presencePenalty?: number;
  readonly frequencyPenalty?: number;
}

export interface LlmRequestConfig {
  readonly model: LlmModel;
  readonly thinking?: ThinkingRequestOptions;
  readonly responseFormat?: ResponseFormat;
  readonly maxCompletionTokens?: number;
  readonly cacheKey?: string;
  readonly sampling?: LlmSampling;
}

export interface LlmRequestContent {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDescription[];
  readonly media?: MediaLowerPorts;
}

export interface LlmRequestControl {
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmRequestEvent) => void;
}

export interface LlmRequester {
  generate(
    config: LlmRequestConfig,
    content: LlmRequestContent,
    control: LlmRequestControl,
  ): Promise<void>;
}

export interface LlmClientContext {
  readonly model: LlmModel;
  readonly headers?: Record<string, string>;
}

export interface LlmRequesterOptions<TClient> {
  readonly clientFactory?: (request: LlmClientContext) => TClient;
}

export function mergeRequestHeaders(
  defaultHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  if (defaultHeaders !== undefined) {
    Object.assign(merged, defaultHeaders);
  }
  if (requestHeaders !== undefined) {
    Object.assign(merged, requestHeaders);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
