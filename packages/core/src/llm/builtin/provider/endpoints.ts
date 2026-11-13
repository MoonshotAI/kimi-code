/**
 * Endpoint declarations for built-in providers: the environment variables that supply each provider's
 * API key and base URL, plus Kimi's default base URL.
 */
import type { LlmEndpointDeclaration } from '#/llm/endpoint';
import {
  DEEPSEEK_ANTHROPIC_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_BASE_URL,
} from '#/llm/builtin/provider/deepseek/index';
import { GLM_DEFAULT_BASE_URL } from '#/llm/builtin/provider/glm/index';
import { KIMI_DEFAULT_BASE_URL } from '#/llm/builtin/provider/kimi/protocol';

export const openAIEndpoint: LlmEndpointDeclaration = {
  apiKeyEnv: 'OPENAI_API_KEY',
  baseUrlEnv: 'OPENAI_BASE_URL',
};

export const anthropicEndpoint: LlmEndpointDeclaration = {
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseUrlEnv: 'ANTHROPIC_BASE_URL',
};

export const geminiEndpoint: LlmEndpointDeclaration = {
  apiKeyEnv: 'GOOGLE_API_KEY',
  baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL',
};

export const vertexEndpoint: LlmEndpointDeclaration = {
  apiKeyEnv: 'VERTEXAI_API_KEY',
  baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL',
};

export const deepseekEndpoint: LlmEndpointDeclaration = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseUrlEnv: 'DEEPSEEK_BASE_URL',
  defaultBaseUrl: DEEPSEEK_DEFAULT_BASE_URL,
};

export const deepseekAnthropicEndpoint: LlmEndpointDeclaration = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseUrlEnv: 'DEEPSEEK_BASE_URL',
  defaultBaseUrl: DEEPSEEK_ANTHROPIC_DEFAULT_BASE_URL,
};

export const glmEndpoint: LlmEndpointDeclaration = {
  apiKeyEnv: 'ZAI_API_KEY',
  baseUrlEnv: 'ZAI_BASE_URL',
  defaultBaseUrl: GLM_DEFAULT_BASE_URL,
};

export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';
export const KIMI_BASE_URL_ENV = 'KIMI_BASE_URL';

export const kimiEndpoint: LlmEndpointDeclaration = {
  apiKeyEnv: KIMI_API_KEY_ENV,
  baseUrlEnv: KIMI_BASE_URL_ENV,
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
};
