import type { ModelCapability } from '#/llm/capability';
import type { LlmRequester } from '#/llm/requester/requester';

import type { ProtocolTrait } from './trait';

export type ProtocolName = 'openai' | 'openai_responses' | 'anthropic' | 'google-genai';

export interface ProtocolBase {
  capability?(modelName: string): ModelCapability | undefined;
  createRequester(trait?: ProtocolTrait): LlmRequester;
}
