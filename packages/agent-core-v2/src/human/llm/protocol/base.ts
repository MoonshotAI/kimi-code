import type { ModelCapability } from '#/llm/capability';
import type { LlmErrorClassifier, LlmRequester } from '#/llm/requester/requester';

import type { ProviderConnection } from './connection';

export type ProtocolName = 'openai' | 'openai_responses' | 'anthropic' | 'google-genai';

export interface ProtocolRequesterOptions<TDialect> {
  readonly connection?: ProviderConnection;
  readonly dialect?: TDialect;
  readonly convertError?: LlmErrorClassifier;
}

export interface ProtocolBase<TDialect = unknown> {
  capability?(modelName: string): ModelCapability | undefined;
  createRequester(options?: ProtocolRequesterOptions<TDialect>): LlmRequester;
}
