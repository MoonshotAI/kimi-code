import {
  anthropicBetaBase,
  createProvider,
  openAIBase,
  openAIResponsesBase,
  type ProtocolBinding,
} from '@moonshot-ai/agent-core';

import { classifyKimiQuotaError } from './errors';
import { kimiMediaContribution } from './media';
import { kimiAnthropicTrait, kimiConnection, kimiOpenAITrait } from './trait';

export function kimiProtocolBindings(): Record<string, ProtocolBinding | undefined> {
  return {
    openai: {
      base: openAIBase,
      trait: kimiOpenAITrait,
      connection: kimiConnection,
      classifyError: classifyKimiQuotaError,
    },
    anthropic: {
      base: anthropicBetaBase,
      trait: kimiAnthropicTrait,
      connection: kimiConnection,
      classifyError: classifyKimiQuotaError,
    },
    openai_responses: {
      base: openAIResponsesBase,
      connection: kimiConnection,
      classifyError: classifyKimiQuotaError,
    },
  };
}

export const kimiProvider = createProvider({
  id: 'kimi',
  protocols: kimiProtocolBindings(),
  media: kimiMediaContribution,
});
