import { createProvider } from '#/llm/provider/definition';
import { anthropicBetaBase } from '#/llm/requester/bases/anthropic/requester';
import { openAIBase } from '#/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#/llm/requester/bases/openai-responses/requester';

import { kimiMediaContribution } from './media';
import { kimiAnthropicTrait, kimiOpenAITrait, kimiResponsesTrait } from './trait';

export const kimiProvider = createProvider({
  id: 'kimi',
  protocols: {
    openai: { base: openAIBase, trait: kimiOpenAITrait },
    anthropic_beta: { base: anthropicBetaBase, trait: kimiAnthropicTrait },
    openai_responses: { base: openAIResponsesBase, trait: kimiResponsesTrait },
  },
  media: kimiMediaContribution,
});
