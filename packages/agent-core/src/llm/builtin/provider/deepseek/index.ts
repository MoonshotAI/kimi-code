import type { LlmEndpoint } from '#/llm/request';
import { createRequester } from '#/llm/requester';

import { deepseekAnthropicFiles, deepseekFiles } from './files';
import { deepseekAnthropicProtocol, deepseekOpenAIProtocol } from './protocol';

export {
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  deepseekAnthropicProtocol,
  deepseekOpenAIProtocol,
  inferDeepSeekCapability,
} from './protocol';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_ANTHROPIC_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';

const deepseekEndpoint: LlmEndpoint = {
  defaultBaseUrl: DEEPSEEK_DEFAULT_BASE_URL,
  files: deepseekFiles,
};

const deepseekAnthropicEndpoint: LlmEndpoint = {
  defaultBaseUrl: DEEPSEEK_ANTHROPIC_DEFAULT_BASE_URL,
  files: deepseekAnthropicFiles,
};

export const deepseekRequester = createRequester().with({
  protocol: { base: deepseekOpenAIProtocol, options: { reasoningKey: 'reasoning_content' } },
  endpoint: deepseekEndpoint,
});

export const deepseekAnthropicRequester = createRequester().with({
  protocol: { base: deepseekAnthropicProtocol },
  endpoint: deepseekAnthropicEndpoint,
});
