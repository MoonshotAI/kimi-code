import type { ModelCapability } from '#/llm/capability';
import type { LlmErrorClassifier, LlmRequester } from '#/llm/requester/requester';

import type { ProviderConnection } from './connection';

export type ProtocolName = 'openai' | 'openai_responses' | 'anthropic' | 'google-genai';

export interface ProtocolRequesterOptions {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
}

export interface ProtocolBase {
  capability?(modelName: string): ModelCapability | undefined;
  createRequester(options?: ProtocolRequesterOptions): LlmRequester;
}
