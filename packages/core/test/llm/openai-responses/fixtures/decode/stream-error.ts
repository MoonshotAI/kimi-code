import type { OpenAIResponsesDecodeFixture } from '../types';

export default {
  name: 'stream-error',
  chunks: [
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'error', code: 'rate_limit_exceeded', message: 'slow down' },
  ],
  expected: [
    { type: 'part', part: { type: 'text', text: 'partial' } },
    {
      type: 'error',
      error: {
        kind: 'rate_limit',
        message: 'slow down',
        retryable: true,
        requestId: null,
        retryAfterMs: null,
        headers: null,
      },
    },
  ],
} satisfies OpenAIResponsesDecodeFixture;
