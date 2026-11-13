import type { LlmEndpoint } from '#/llm/request';
import { createRequester } from '#/llm/requester';

import { miniMaxAnthropicProtocol, miniMaxOpenAIProtocol } from './protocol';

export {
  MINIMAX_DEFAULT_MAX_OUTPUT_TOKENS,
  MINIMAX_MAX_OUTPUT_TOKENS,
  inferMiniMaxCapability,
  miniMaxAnthropicProtocol,
  miniMaxOpenAIProtocol,
} from './protocol';

export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.cn/v1';
export const MINIMAX_ANTHROPIC_DEFAULT_BASE_URL = 'https://api.minimax.cn/anthropic';

const miniMaxEndpoint: LlmEndpoint = {
  defaultBaseUrl: MINIMAX_DEFAULT_BASE_URL,
};

const miniMaxAnthropicEndpoint: LlmEndpoint = {
  defaultBaseUrl: MINIMAX_ANTHROPIC_DEFAULT_BASE_URL,
};

export const miniMaxRequester = createRequester().with({
  protocol: { base: miniMaxOpenAIProtocol, options: { reasoningKey: 'reasoning_content' } },
  endpoint: miniMaxEndpoint,
});

export const miniMaxAnthropicRequester = createRequester().with({
  protocol: { base: miniMaxAnthropicProtocol },
  endpoint: miniMaxAnthropicEndpoint,
});

export const miniMaxRequesters = {
  openai: miniMaxRequester,
  anthropic: miniMaxAnthropicRequester,
} as const;
