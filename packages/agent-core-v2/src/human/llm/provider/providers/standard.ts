import type { ProtocolTrait } from '#/llm/protocol/trait';
import { createProvider } from '#/llm/provider/definition';
import { anthropicBase } from '#/llm/requester/bases/anthropic/requester';
import { createGoogleGenAIBase, googleGenAIBase } from '#/llm/requester/bases/google-genai/requester';
import { openAIBase } from '#/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#/llm/requester/bases/openai-responses/requester';

const openAITrait: ProtocolTrait = {
  endpoint: () => ({ apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' }),
};

export const openaiProvider = createProvider({
  id: 'openai',
  protocols: {
    openai: { base: openAIBase, trait: openAITrait },
    openai_responses: { base: openAIResponsesBase, trait: openAITrait },
  },
});

export const anthropicProvider = createProvider({
  id: 'anthropic',
  protocols: {
    anthropic: {
      base: anthropicBase,
      trait: {
        endpoint: () => ({ apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' }),
      },
    },
  },
});

export const googleProvider = createProvider({
  id: 'google',
  protocols: {
    'google-genai': {
      base: googleGenAIBase,
      trait: {
        endpoint: () => ({ apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' }),
      },
    },
    'google-vertex': {
      base: createGoogleGenAIBase({ vertexai: true }),
      trait: {
        endpoint: () => ({ apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }),
      },
    },
  },
  media: { inlineVideo: true },
});
