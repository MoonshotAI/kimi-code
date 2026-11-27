import { testModule } from '../../../harness';
import type { KimiOpenAITransportFixture } from '../types';

export default {
  name: 'as a Kimi OpenAI user, I want quota errors to retain their trace diagnostics',
  module: testModule(),
  endpoint: { baseUrl: 'https://example.test/v1', apiKey: 'test-key' },
  stream: false,
  response: {
    status: 429,
    headers: { 'x-trace-id': 'trace-quota', 'x-request-id': 'req-kimi-quota' },
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
        requestId: 'req-kimi-quota',
        retryable: false,
      },
    },
  },
} satisfies KimiOpenAITransportFixture;
