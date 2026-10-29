import { KIMI_DEFAULT_BASE_URL } from '#/llm/builtin/provider/kimi/protocol';

import type { ProtocolEndpoint, ProtocolEndpointResolver } from './connection';

export const openAIEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'OPENAI_API_KEY',
  baseUrlEnv: 'OPENAI_BASE_URL',
};

export const anthropicEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseUrlEnv: 'ANTHROPIC_BASE_URL',
};

export const geminiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'GOOGLE_API_KEY',
  baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL',
};

export const vertexEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'VERTEXAI_API_KEY',
  baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL',
};

export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';
export const KIMI_BASE_URL_ENV = 'KIMI_BASE_URL';

export const kimiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: KIMI_API_KEY_ENV,
  baseUrlEnv: KIMI_BASE_URL_ENV,
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
};

export const googleGenAIEndpoint: ProtocolEndpointResolver = (ctx) =>
  ctx?.model.vertexai === true ? vertexEndpoint : geminiEndpoint;
