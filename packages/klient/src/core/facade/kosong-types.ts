import type { Message } from '@moonshot-ai/agent-core-v2/llm-adapter/contract/message';
import type {
  StreamedMessagePart,
  ToolDescription as Tool,
} from '@moonshot-ai/agent-core-v2/human/llm/message';
import type { TokenUsage } from '@moonshot-ai/agent-core-v2/human/llm/usage';
import type { ResponseFormat } from '@moonshot-ai/agent-core-v2/human/llm/response-format';

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

export interface GenerateParams {
  readonly cacheKey?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly thinkingEffort?: string;
  readonly maxCompletionTokens?: number;
}

export type GenerateEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | { readonly type: 'finish'; readonly message: Message; readonly finishReason?: string; readonly id?: string }
  | { readonly type: 'timing'; readonly firstTokenLatencyMs: number; readonly streamDurationMs: number; readonly [key: string]: unknown };
