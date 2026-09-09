import type { ModelCapability } from '#/llm/capability';
import type { LlmErrorClassifier, LlmRequester } from '#/llm/requester/requester';

import type { ProviderConnection } from './connection';

export type ProtocolName = 'openai' | 'openai_responses' | 'anthropic' | 'google-genai';

export interface ProtocolRequesterOptions<TTrait> {
  readonly connection?: ProviderConnection;
  readonly trait?: TTrait;
  readonly convertError?: LlmErrorClassifier;
}

export interface ProtocolBase<TTrait = unknown> {
  capability?(modelName: string): ModelCapability | undefined;
  createRequester(options?: ProtocolRequesterOptions<TTrait>): LlmRequester;
}
