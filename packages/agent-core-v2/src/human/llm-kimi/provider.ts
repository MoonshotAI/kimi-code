import { createProvider } from '#/llm/provider/definition';

import { classifyKimiQuotaError } from './errors';
import { kimiMediaContribution } from './media';
import {
  kimiAnthropicBase,
  kimiConnection,
  kimiOpenAIBase,
  kimiResponsesBase,
} from './protocol';

export const kimiProvider = createProvider({
  id: 'kimi',
  protocols: {
    openai: {
      base: kimiOpenAIBase,
      connection: kimiConnection,
      classifyError: classifyKimiQuotaError,
    },
    anthropic: {
      base: kimiAnthropicBase,
      connection: kimiConnection,
      classifyError: classifyKimiQuotaError,
    },
    openai_responses: {
      base: kimiResponsesBase,
      connection: kimiConnection,
      classifyError: classifyKimiQuotaError,
    },
  },
  media: kimiMediaContribution,
});
