import type { ModelCapability } from '#/llm/capability';
import type { LlmRequester } from '#/llm/requester/requester';

import type { ProviderConnection } from './connection';
import type { ProtocolDialect } from './dialect';
import type { ModelPolicy } from './policy';

export type ProtocolName =
  | 'openai'
  | 'openai_responses'
  | 'anthropic'
  | 'anthropic_beta'
  | 'google-genai'
  | 'google-vertex';

export interface ProtocolWiring {
  readonly connection?: ProviderConnection;
  readonly dialect?: ProtocolDialect;
  readonly policy?: ModelPolicy;
}

export interface ProtocolBase {
  capability?(modelName: string): ModelCapability | undefined;
  createRequester(wiring?: ProtocolWiring): LlmRequester;
}
