import type { LlmErrorMessage, LlmRemoteErrorMessage } from '#/llm/errors';
import type { FinishInfo } from '#/llm/finish-reason';
import type {
  Message,
  StreamedMessagePart,
  ToolDescription,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { ResponseFormat } from '#/llm/response-format';
import type { ThinkingRequestOptions } from '#/llm/thinking';
import type { TokenUsage } from '#/llm/usage';

import type { AnthropicExtraParams } from './bases/anthropic/extra-params';
import type { GoogleGenAIExtraParams } from './bases/google-genai/extra-params';
import type { OpenAIExtraParams } from './bases/openai/extra-params';
import type { OpenAIResponsesExtraParams } from './bases/openai-responses/extra-params';

export interface ToolCallIdPolicy {
  normalize: (id: string) => string;
  maxLength?: number;
}

export type LlmRequestEvent =
  | { type: 'llm.sent' }
  | { type: 'llm.headers'; headers: Record<string, string> }
  | { type: 'llm.delta'; part: StreamedMessagePart }
  | { type: 'llm.usage'; usage: Partial<TokenUsage> }
  | { type: 'llm.finish'; finish: FinishInfo }
  | { type: 'llm.message-id'; messageId: string }
  | { type: 'llm.failed.syntax'; error: LlmErrorMessage<'syntax'> }
  | { type: 'llm.failed.remote'; error: LlmRemoteErrorMessage }
  | { type: 'llm.done' };

export interface ExtraParams {
  readonly openai?: OpenAIExtraParams;
  readonly responses?: OpenAIResponsesExtraParams;
  readonly anthropic?: AnthropicExtraParams;
  readonly googleGenai?: GoogleGenAIExtraParams;
}

export type ToolMessageConversion = 'extract_text' | 'keep_parts';

export interface LlmRequestConfig {
  readonly model: LlmModel;
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDescription[];
  readonly cacheKey?: string;
  readonly thinking?: ThinkingRequestOptions;
  readonly responseFormat?: ResponseFormat;
  readonly maxCompletionTokens?: number;
  readonly maxContextTokens?: number;
  readonly extraParams?: ExtraParams;
  readonly toolMessageConversion?: ToolMessageConversion;
}

export interface LlmRequestContent {
  readonly messages: readonly Message[];
  readonly usedContextTokens?: number;
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
