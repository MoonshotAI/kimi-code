import type { ProviderConnection } from '#/llm/protocol/connection';
import { createProvider } from '#/llm/provider/definition';
import { anthropicBase } from '#/llm/requester/bases/anthropic/requester';
import { createGoogleGenAIBase, googleGenAIBase } from '#/llm/requester/bases/google-genai/requester';
import { openAIBase } from '#/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#/llm/requester/bases/openai-responses/requester';

export const openAIConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' }),
};

export const anthropicConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' }),
};

export const geminiConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' }),
};

export const vertexConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }),
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
    'google-genai': { base: googleGenAIBase, connection: geminiConnection },
    'google-vertex': {
      base: createGoogleGenAIBase({ vertexai: true }),
      connection: vertexConnection,
    },
  },
  media: { inlineVideo: true },
});
