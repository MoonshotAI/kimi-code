import type { LlmEndpoint } from '#/llm/request';
import { createRequester } from '#/llm/requester';

import { kimiAnthropicFiles, kimiFiles } from './files';
import {
  KIMI_DEFAULT_BASE_URL,
  kimiAnthropicProtocol,
  kimiOpenAIProtocol,
  kimiResponsesProtocol,
} from './protocol';

export { classifyKimiQuotaError } from './errors';
export { KIMI_DEFAULT_BASE_URL, kimiAnthropicProtocol, kimiOpenAIProtocol, kimiResponsesProtocol } from './protocol';

const kimiEndpoint: LlmEndpoint = {
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
  files: kimiFiles,
};

const kimiAnthropicEndpoint: LlmEndpoint = {
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
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

export const kimiRequesters = {
  openai: kimiRequester,
  anthropic: kimiAnthropicRequester,
  openai_responses: kimiResponsesRequester,
} as const;
