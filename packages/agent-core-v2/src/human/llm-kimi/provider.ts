import { createProvider } from '#/llm/provider/definition';
import { anthropicBetaBase } from '#/llm/requester/bases/anthropic/requester';
import { openAIBase } from '#/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#/llm/requester/bases/openai-responses/requester';

import { kimiAnthropicTrait, kimiConnection, kimiOpenAITrait } from './trait';
import { classifyKimiQuotaError } from './errors';
import { kimiMediaContribution } from './media';

export const kimiProvider = createProvider({
  id: 'kimi',
  protocols: {
    openai: {
      base: openAIBase,
      trait: kimiOpenAITrait,
      connection: kimiConnection,
      convertError: classifyKimiQuotaError,
    },
    anthropic: {
      base: anthropicBetaBase,
      trait: kimiAnthropicTrait,
      connection: kimiConnection,
      convertError: classifyKimiQuotaError,
    },
    openai_responses: {
      base: openAIResponsesBase,
      connection: kimiConnection,
      convertError: classifyKimiQuotaError,
    },
  },
  media: kimiMediaContribution,
});
