import type { ProviderConnection } from '#/llm/protocol/connection';
import { createProvider } from '#/llm/provider/definition';
import { anthropicBase } from '#/llm/requester/bases/anthropic/requester';
import { googleGenAIBase } from '#/llm/requester/bases/google-genai/requester';
import { openAIBase } from '#/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#/llm/requester/bases/openai-responses/requester';

const openAIConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' }),
};

const anthropicConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' }),
};

export const googleGenAIConnection: ProviderConnection = {
  endpoint: (ctx) =>
    ctx?.model.vertexai === true
      ? { apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }
      : { apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' },
};

export const openaiProvider = createProvider({
  id: 'openai',
  protocols: {
    openai: { base: openAIBase, connection: openAIConnection },
    openai_responses: { base: openAIResponsesBase, connection: openAIConnection },
  },
});

export const anthropicProvider = createProvider({
  id: 'anthropic',
  protocols: {
    anthropic: { base: anthropicBase, connection: anthropicConnection },
  },
});

export const googleProvider = createProvider({
  id: 'google',
  protocols: {
    'google-genai': { base: googleGenAIBase, connection: googleGenAIConnection },
  },
  media: { inlineVideo: true },
});
