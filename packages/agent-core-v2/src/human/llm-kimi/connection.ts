import type { ProtocolEndpoint, ProviderConnection } from '#/llm/protocol/connection';

import { classifyKimiQuotaError } from './errors';

export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';
export const KIMI_BASE_URL_ENV = 'KIMI_BASE_URL';
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

export const kimiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: KIMI_API_KEY_ENV,
  baseUrlEnv: KIMI_BASE_URL_ENV,
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
};

export const kimiConnection: ProviderConnection = {
  endpoint: () => kimiEndpoint,
  convertError: (error) => classifyKimiQuotaError(error),
};
