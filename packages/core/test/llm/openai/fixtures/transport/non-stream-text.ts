import { testModule } from '../../../harness';
import type { OpenAITransportFixture } from '../types';

export default {
  name: 'non-stream-text',
  module: testModule(),
  endpoint: { baseUrl: 'https://example.test/v1', apiKey: 'test-key' },
  stream: false,
  response: {
    headers: { 'x-request-id': 'req-non-stream-1' },
    json: {
      id: 'chatcmpl-non-stream',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '非流式你好' },
        finish_reason: 'stop',
      }],
    },
  },
  expected: {
    url: 'https://example.test/v1/chat/completions',
    body: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    },
    outcome: {
      type: 'done',
      requestId: 'req-non-stream-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '非流式你好' }],
        toolCalls: [],
      },
      finish: { finishReason: 'completed', rawFinishReason: 'stop' },
      messageId: 'chatcmpl-non-stream',
    },
  },
} satisfies OpenAITransportFixture;
