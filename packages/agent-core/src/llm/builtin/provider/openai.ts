import { openAIResponsesBase } from '#/llm/builtin/protocol/openai-responses/index';
import { openAIBase } from '#/llm/builtin/protocol/openai/index';
import type { ProviderConnection } from '#/llm/protocol/connection';
import { createProvider } from '#/llm/provider';

const openAIConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' }),
};

export const openaiProvider = createProvider({
  id: 'openai',
  protocols: {
    openai: { base: openAIBase, connection: openAIConnection },
    openai_responses: { base: openAIResponsesBase, connection: openAIConnection },
  },
});
