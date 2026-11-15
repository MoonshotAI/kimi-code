import { testModule } from '../../../harness';
import type { OpenAIResponsesTransportFixture } from '../types';

export default {
  name: 'non-stream-text',
  module: testModule(),
  endpoint: { baseUrl: 'https://example.test/v1', apiKey: 'test-key' },
  stream: false,
  response: {
    headers: { 'x-request-id': 'req-responses-non-stream' },
    json: {
      id: 'resp-non-stream',
      status: 'completed',
      model: 'test-model',
      output: [{
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '非流式 Responses', annotations: [] }],
      }],
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  },
  expected: {
    url: 'https://example.test/v1/responses',
    body: { model: 'test-model', store: false, stream: false },
    outcome: {
      type: 'done',
      requestId: 'req-responses-non-stream',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '非流式 Responses' }],
        toolCalls: [],
      },
      usage: { inputOther: 5, inputCacheRead: 0, output: 2 },
      finish: { finishReason: 'completed', rawFinishReason: 'completed' },
      messageId: 'resp-non-stream',
    },
  },
} satisfies OpenAIResponsesTransportFixture;
