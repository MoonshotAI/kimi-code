import type { Message, ToolDescription as Tool } from '@moonshot-ai/core/llm/message';
import type { ResponseFormat } from '@moonshot-ai/core/llm/request';
import type { InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { LlmRunEvent } from '@moonshot-ai/core/llm/response';

export type ProviderAuth =
  | { method: 'api-key'; apiKey: string }
  | { method: 'oauth' };

export interface ProviderInput {
  type: string;
  baseUrl?: string;
  auth: ProviderAuth;
  defaultModel?: string;
}

export interface AnonymousProviderInput {
  id: string;
  model: string;
  protocol: string;
  baseUrl: string;
  auth: ProviderAuth;
  displayName?: string;
  maxContextSize?: number;
  capabilities?: Record<string, boolean>;
}

export interface GenerateInput {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
  readonly responseFormat?: ResponseFormat;
}

export type GenerateParams = InitializedLlmRequestPart;

export type GenerateEvent = LlmRunEvent;
