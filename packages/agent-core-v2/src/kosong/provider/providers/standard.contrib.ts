import { registerProviderDefinition } from '../providerDefinition';

registerProviderDefinition({
  id: 'anthropic',
  baseProtocol: 'anthropic',
  traits: [],
  endpoint: { apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai',
  baseProtocol: 'openai',
  traits: [],
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai_responses',
  baseProtocol: 'openai_responses',
  traits: [],
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'google-genai',
  baseProtocol: 'google-genai',
  traits: [
    { endpoint: () => ({ apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }) },
    { endpoint: () => ({ apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' }) },
  ],
});
