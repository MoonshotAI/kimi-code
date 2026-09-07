import { createProvider } from '#/llm/provider/definition';
import { anthropicBetaBase } from '#/llm/requester/bases/anthropic/requester';
import { openAIBase } from '#/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#/llm/requester/bases/openai-responses/requester';

import { kimiConnection } from './connection';
import { kimiMediaContribution } from './media';
import { kimiAnthropicPolicy, kimiOpenAIDialect, kimiOpenAIPolicy } from './wiring';

export const kimiProvider = createProvider({
  id: 'kimi',
  protocols: {
    openai: {
      base: openAIBase,
      connection: kimiConnection,
      dialect: kimiOpenAIDialect,
      policy: kimiOpenAIPolicy,
    },
    anthropic_beta: { base: anthropicBetaBase, connection: kimiConnection, policy: kimiAnthropicPolicy },
    openai_responses: { base: openAIResponsesBase, connection: kimiConnection },
  },
  media: kimiMediaContribution,
});
