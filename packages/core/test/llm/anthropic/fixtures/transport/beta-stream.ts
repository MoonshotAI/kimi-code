import { testModule } from '../../../harness';
import type { AnthropicTransportFixture } from '../types';

export default {
  name: 'beta-stream',
  module: testModule({ options: { betaApi: true } }),
  endpoint: { baseUrl: 'https://example.test', apiKey: 'test-key' },
  response: {
    headers: { 'request-id': 'req-anthropic-beta' },
    sse: {
      eventNames: true,
      events: [
        {
          type: 'message_start',
          message: {
            id: 'msg-beta',
            type: 'message',
            role: 'assistant',
            model: 'test-model',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'beta' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        },
        { type: 'message_stop' },
      ],
    },
  },
  expected: {
    url: 'https://example.test/v1/messages?beta=true',
    headers: { 'x-api-key': 'test-key' },
    body: { stream: true },
    outcome: {
      type: 'done',
      requestId: 'req-anthropic-beta',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'beta' }],
        toolCalls: [],
      },
      messageId: 'msg-beta',
    },
  },
} satisfies AnthropicTransportFixture;
