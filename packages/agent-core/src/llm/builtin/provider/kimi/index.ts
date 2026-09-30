import type { LlmEndpoint } from '#/llm/request';
import { createRequester } from '#/llm/requester';

import { kimiAnthropicFiles, kimiFiles } from './files';
import { kimiAnthropicProtocol, kimiOpenAIProtocol, kimiResponsesProtocol } from './protocol';

export {
  classifyKimiQuotaError,
  kimiAnthropicProtocol,
  kimiOpenAIProtocol,
  kimiResponsesProtocol,
} from './protocol';

export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
export const KIMI_ANTHROPIC_DEFAULT_BASE_URL = 'https://api.moonshot.ai/anthropic';

const kimiEndpoint: LlmEndpoint = {
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
  files: kimiFiles,
};

const kimiAnthropicEndpoint: LlmEndpoint = {
  defaultBaseUrl: KIMI_ANTHROPIC_DEFAULT_BASE_URL,
  files: kimiAnthropicFiles,
};

export const kimiRequester = createRequester().with({
  protocol: { base: kimiOpenAIProtocol },
  endpoint: kimiEndpoint,
});

export const kimiAnthropicRequester = createRequester().with({
  protocol: { base: kimiAnthropicProtocol, options: { betaApi: true } },
  endpoint: kimiAnthropicEndpoint,
});

export const kimiResponsesRequester = createRequester().with({
  protocol: { base: kimiResponsesProtocol },
  endpoint: kimiEndpoint,
});
