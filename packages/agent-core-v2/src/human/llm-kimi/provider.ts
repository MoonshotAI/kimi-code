import { createProvider } from '#/llm/provider/definition';
import { anthropicBetaBase } from '#/llm/requester/bases/anthropic/requester';
import { openAIBase } from '#/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#/llm/requester/bases/openai-responses/requester';

import { kimiAnthropicDialect, kimiConnection, kimiOpenAIDialect } from './dialect';
import { classifyKimiQuotaError } from './errors';
import { kimiMediaContribution } from './media';

export const kimiProvider = createProvider({
  id: 'kimi',
  protocols: {
    openai: {
      base: openAIBase,
      dialect: kimiOpenAIDialect,
      connection: kimiConnection,
      convertError: classifyKimiQuotaError,
    },
    anthropic: {
      base: anthropicBetaBase,
      dialect: kimiAnthropicDialect,
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
