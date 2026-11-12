import { testModule } from '../../../harness';
import type { OpenAIResponsesTransportFixture } from '../types';

export default {
  name: 'rate-limit',
  module: testModule(),
  endpoint: { baseUrl: 'https://example.test/v1', apiKey: 'test-key' },
  stream: false,
  response: {
    status: 429,
    headers: { 'x-request-id': 'req-responses-rate-limit', 'retry-after': '1' },
    json: {
      error: {
        message: 'slow down',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    },
  },
  expected: {
    url: 'https://example.test/v1/responses',
    body: { stream: false, store: false },
    outcome: {
      type: 'failed',
      error: {
        kind: 'rate_limit',
        message: 'slow down',
        statusCode: 429,
        requestId: 'req-responses-rate-limit',
        retryAfterMs: 1000,
        retryable: true,
      },
    },
  },
} satisfies OpenAIResponsesTransportFixture;
