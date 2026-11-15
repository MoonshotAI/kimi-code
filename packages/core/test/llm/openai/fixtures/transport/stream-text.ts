import { testModule } from '../../../harness';
import type { OpenAITransportFixture } from '../types';

export default {
  name: 'stream-text',
  module: testModule(),
  endpoint: {
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    headers: { 'x-custom': 'custom' },
  },
  response: {
    headers: { 'x-request-id': 'req-stream-1' },
    sse: {
      events: [
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ],
    },
  },
  expected: {
    url: 'https://example.test/v1/chat/completions',
    headers: { authorization: 'Bearer test-key', 'x-custom': 'custom' },
    body: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    },
    outcome: {
      type: 'done',
      requestId: 'req-stream-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '你好' }],
        toolCalls: [],
      },
      finish: { finishReason: 'completed', rawFinishReason: 'stop' },
      messageId: 'chatcmpl-1',
    },
  },
} satisfies OpenAITransportFixture;
