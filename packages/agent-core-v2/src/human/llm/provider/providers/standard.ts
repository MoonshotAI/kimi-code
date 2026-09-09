import type { ProtocolTrait } from '#/llm/protocol/trait';
import { createProvider } from '#/llm/provider/definition';
import { anthropicBase } from '#/llm/requester/bases/anthropic/requester';
import { googleGenAIBase } from '#/llm/requester/bases/google-genai/requester';
import { openAIBase } from '#/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#/llm/requester/bases/openai-responses/requester';

const openAITrait: ProtocolTrait = {
  endpoint: () => ({ apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' }),
};

const anthropicTrait: ProtocolTrait = {
  endpoint: () => ({ apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' }),
};

export const googleGenAITrait: ProtocolTrait = {
  endpoint: (ctx) =>
    ctx?.model.vertexai === true
      ? { apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }
      : { apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' },
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
    anthropic: { base: anthropicBase, trait: anthropicTrait },
  },
});

export const googleProvider = createProvider({
  id: 'google',
  protocols: {
    'google-genai': { base: googleGenAIBase, trait: googleGenAITrait },
  },
  media: { inlineVideo: true },
});
