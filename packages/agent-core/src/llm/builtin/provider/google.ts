import { googleGenAIBase } from '#/llm/builtin/protocol/google-genai/index';
import type { ProviderConnection } from '#/llm/protocol/connection';
import { createProvider } from '#/llm/provider';

export const googleGenAIConnection: ProviderConnection = {
  endpoint: (ctx) =>
    ctx?.model.vertexai === true
      ? { apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }
      : { apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' },
};

export const googleProvider = createProvider({
  id: 'google',
  protocols: {
    'google-genai': { base: googleGenAIBase, connection: googleGenAIConnection },
  },
  media: { inlineVideo: true },
});
