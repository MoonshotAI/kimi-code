import { createStaticCredentialProvider } from '#/llm/builtin/policy/credentials';
import type { LlmEndpoint } from '#/llm/request';

type Env = Readonly<Record<string, string | undefined>>;

export interface EndpointEnvNames {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export const PROVIDER_ENV = {
  openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
  anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
  google: { apiKey: 'GOOGLE_API_KEY', baseUrl: 'GOOGLE_GEMINI_BASE_URL' },
  vertex: { apiKey: 'VERTEXAI_API_KEY', baseUrl: 'GOOGLE_VERTEX_BASE_URL' },
  kimi: { apiKey: 'KIMI_API_KEY', baseUrl: 'KIMI_BASE_URL' },
  kimiAnthropic: { apiKey: 'KIMI_API_KEY' },
  deepseek: { apiKey: 'DEEPSEEK_API_KEY', baseUrl: 'DEEPSEEK_BASE_URL' },
  deepseekAnthropic: { apiKey: 'DEEPSEEK_API_KEY' },
  glm: { apiKey: 'ZAI_API_KEY', baseUrl: 'ZAI_BASE_URL' },
} as const satisfies Record<string, EndpointEnvNames>;

function read(env: Env, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const value = env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function endpointFromEnv(names: EndpointEnvNames, env: Env = process.env): LlmEndpoint {
  const baseUrl = read(env, names.baseUrl);
  const apiKey = read(env, names.apiKey);
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { credentials: createStaticCredentialProvider(apiKey) }),
  };
}
