import Anthropic from '@anthropic-ai/sdk';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import {
  anthropicProtocol,
  buildDefaultHeaders,
} from '#/llm/builtin/protocol/anthropic/index';
import { createRequester } from '#/llm/requester';

function createClient(endpoint: ResolvedEndpoint): Anthropic {
  const defaultHeaders = buildDefaultHeaders(endpoint.headers);
  if (defaultHeaders['authorization'] === null) delete defaultHeaders['authorization'];
  return new Anthropic({
    apiKey: null,
    authToken: endpoint.apiKey ?? null,
    baseURL: endpoint.baseUrl ?? null,
    defaultHeaders,
    maxRetries: 0,
    fetch: endpoint.fetch,
  });
}

export const bedrockAnthropicProtocol = anthropicProtocol.with({
  client: createClient,
});

export const bedrockAnthropicRequester = createRequester().with({
  protocol: { base: bedrockAnthropicProtocol },
});
