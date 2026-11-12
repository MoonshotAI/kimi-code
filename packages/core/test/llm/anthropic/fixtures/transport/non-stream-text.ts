import { TEST_MODEL, testModule } from '../../../harness';
import type { AnthropicTransportFixture } from '../types';

export default {
  name: 'non-stream-text',
  module: testModule({ model: { ...TEST_MODEL, maxOutputTokens: 1024 } }),
  endpoint: { baseUrl: 'https://example.test', apiKey: 'test-key' },
  stream: false,
  response: {
    headers: { 'request-id': 'req-anthropic-non-stream' },
    json: {
      id: 'msg-non-stream',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: '非流式 Anthropic' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 3 },
    },
  },
  expected: {
    url: 'https://example.test/v1/messages',
    body: { stream: false },
    outcome: {
      type: 'done',
      requestId: 'req-anthropic-non-stream',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '非流式 Anthropic' }],
        toolCalls: [],
      },
      usage: { inputOther: 2, output: 3 },
      messageId: 'msg-non-stream',
    },
  },
} satisfies AnthropicTransportFixture;
