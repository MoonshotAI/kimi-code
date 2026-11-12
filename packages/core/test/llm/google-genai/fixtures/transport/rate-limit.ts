import { testModule } from '../../../harness';
import type { GoogleGenAITransportFixture } from '../types';

export default {
  name: 'rate-limit',
  module: testModule(),
  endpoint: { baseUrl: 'https://example.test/v1beta', apiKey: 'test-key' },
  stream: false,
  response: {
    status: 429,
    json: {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'slow down',
        requestId: 'req-google-rate-limit',
        details: [{ '@type': 'google.rpc.RetryInfo', retryDelay: '1.5s' }],
      },
    },
  },
  expected: {
    url: 'https://example.test/v1beta/models/test-model:generateContent',
    outcome: {
      type: 'failed',
      error: {
        kind: 'rate_limit',
        message: 'slow down',
        statusCode: 429,
        requestId: 'req-google-rate-limit',
        retryAfterMs: 1500,
        retryable: true,
      },
    },
  },
} satisfies GoogleGenAITransportFixture;
