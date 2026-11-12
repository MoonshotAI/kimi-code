import { testModule } from '../../../harness';
import type { KimiOpenAITransportFixture } from '../types';

export default {
  name: 'kimi-openai-quota-error',
  module: testModule(),
  endpoint: { baseUrl: 'https://example.test/v1', apiKey: 'test-key' },
  stream: false,
  response: {
    status: 429,
    headers: { 'x-trace-id': 'trace-quota' },
    json: {
      error: { message: 'quota used', type: 'exceeded_current_quota_error' },
    },
  },
  expected: {
    url: 'https://example.test/v1/chat/completions',
    body: { stream: false },
    outcome: {
      type: 'failed',
      diagnostics: { requestId: 'trace-quota' },
      error: {
        kind: 'quota_exhausted',
        message: 'quota used',
        statusCode: 429,
        requestId: null,
        retryable: false,
      },
    },
  },
} satisfies KimiOpenAITransportFixture;
