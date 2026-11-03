import type { LlmErrorMessage, LlmRemoteErrorMessage } from '#/llm-requester/errors';
import type { FinishInfo } from '#/llm-requester/finish-reason';
import type {
  Message,
  StreamedMessagePart,
  ToolDescription,
} from '#/llm/message';
import type { LlmModel } from '#/llm-requester/model';
import type { ResponseFormat } from '#/llm-requester/response-format';
import type { ThinkingRequestOptions } from '#/llm-requester/thinking';
import type { TokenUsage } from '#/llm-requester/usage';

import type { LlmCredentialProvider } from '#/llm/request';
import type { LlmRemoteErrorMessage as CoreLlmRemoteErrorMessage } from '#/llm/response';

import type { AnthropicExtraParams } from '#/llm/builtin/protocol/anthropic/extra-params';
import type { GoogleGenAIExtraParams } from '#/llm/builtin/protocol/google-genai/extra-params';
import type { OpenAIExtraParams } from '#/llm/builtin/protocol/openai/extra-params';
import type { OpenAIResponsesExtraParams } from '#/llm/builtin/protocol/openai-responses/extra-params';

export type { LlmCredential, LlmCredentialProvider } from '#/llm/request';

export type ProtocolName = 'openai' | 'openai_responses' | 'anthropic' | 'google-genai';

export interface ToolCallIdPolicy {
  normalize: (id: string) => string;
  maxLength?: number;
}

export type LlmErrorClassifier = (error: unknown) => CoreLlmRemoteErrorMessage | undefined;

export type LlmRequestEvent =
  | { type: 'llm.sent' }
  | { type: 'llm.streaming.headers'; headers: Record<string, string> }
  | { type: 'llm.streaming.part'; part: StreamedMessagePart }
  | { type: 'llm.streaming.usage'; usage: Partial<TokenUsage> }
  | { type: 'llm.streaming.finish'; finish: FinishInfo }
  | { type: 'llm.streaming.message_id'; messageId: string }
  | { type: 'llm.failed.syntax'; error: LlmErrorMessage<'syntax'> }
  | { type: 'llm.failed.remote'; error: LlmRemoteErrorMessage; rawError?: unknown }
  | { type: 'llm.request.retrying' }
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
  readonly credentialProvider?: LlmCredentialProvider;
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDescription[];
  readonly cacheKey?: string;
  readonly thinking?: ThinkingRequestOptions;
  readonly responseFormat?: ResponseFormat;
  readonly maxCompletionTokens?: number;
  readonly maxContextTokens?: number;
  readonly extraParams?: ExtraParams;
  readonly toolMessageConversion?: ToolMessageConversion;
  readonly stream?: boolean;
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
