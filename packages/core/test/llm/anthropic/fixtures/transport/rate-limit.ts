import { TEST_MODEL, testModule } from '../../../harness';
import type { AnthropicTransportFixture } from '../types';

export default {
  name: 'rate-limit',
  module: testModule({ model: { ...TEST_MODEL, maxOutputTokens: 1024 } }),
  endpoint: { baseUrl: 'https://example.test', apiKey: 'test-key' },
  stream: false,
  response: {
    status: 429,
    headers: { 'request-id': 'req-anthropic-rate-limit', 'retry-after': '1' },
    json: {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    },
  },
  expected: {
    url: 'https://example.test/v1/messages',
    body: { stream: false },
    outcome: {
      type: 'failed',
      error: {
        kind: 'rate_limit',
        message: 'slow down',
        statusCode: 429,
        requestId: 'req-anthropic-rate-limit',
        retryAfterMs: 1000,
        retryable: true,
      },
    },
  },
} satisfies AnthropicTransportFixture;
