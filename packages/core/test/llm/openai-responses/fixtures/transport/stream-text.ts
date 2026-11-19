import { testModule } from '../../../harness';
import type { OpenAIResponsesTransportFixture } from '../types';

export default {
  name: 'as a Responses API user, I want streamed text and custom headers to use the real HTTP transport',
  module: testModule(),
  endpoint: {
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    headers: { 'x-custom': 'custom' },
  },
  response: {
    headers: { 'x-request-id': 'req-responses-stream' },
    sse: {
      events: [
        { type: 'response.output_text.delta', delta: 'Responses 你好' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-stream',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Responses 你好' }] }],
          },
        },
      ],
    },
  },
  expected: {
    url: 'https://example.test/v1/responses',
    headers: { authorization: 'Bearer test-key', 'x-custom': 'custom' },
    body: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    },
    outcome: {
      type: 'done',
      requestId: 'req-responses-stream',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Responses 你好' }],
        toolCalls: [],
      },
      finish: { finishReason: 'completed', rawFinishReason: 'completed' },
      messageId: 'resp-stream',
    },
  },
} satisfies OpenAIResponsesTransportFixture;
