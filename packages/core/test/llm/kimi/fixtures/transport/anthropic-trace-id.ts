import { TEST_MODEL, testModule } from '../../../harness';
import type { KimiAnthropicTransportFixture } from '../types';

export default {
  name: 'kimi-anthropic-trace-id',
  module: testModule({ model: { ...TEST_MODEL, maxOutputTokens: 1024 } }),
  endpoint: { baseUrl: 'https://example.test', apiKey: 'test-key' },
  stream: false,
  response: {
    headers: { 'x-trace-id': 'trace-anthropic' },
    json: {
      id: 'msg-kimi',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'kimi anthropic' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  expected: {
    url: 'https://example.test/v1/messages',
    body: { stream: false },
    outcome: {
      type: 'done',
      requestId: 'trace-anthropic',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'kimi anthropic' }],
        toolCalls: [],
      },
      messageId: 'msg-kimi',
    },
  },
} satisfies KimiAnthropicTransportFixture;
