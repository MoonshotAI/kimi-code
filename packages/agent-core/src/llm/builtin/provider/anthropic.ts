import { anthropicBase } from '#/llm/builtin/protocol/anthropic/index';
import type { ProviderConnection } from '#/llm/protocol/connection';
import { createProvider } from '#/llm/provider';

const anthropicConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' }),
};

export const anthropicProvider = createProvider({
  id: 'anthropic',
  protocols: {
    anthropic: { base: anthropicBase, connection: anthropicConnection },
  },
});
