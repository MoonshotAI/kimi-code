import { testModule } from '../../../harness';
import type { GoogleGenAITransportFixture } from '../types';

export default {
  name: 'vertex-non-stream',
  module: testModule({ options: { vertexai: true } }),
  endpoint: {
    baseUrl: 'https://example.test/proxy/v1beta1/',
    apiKey: 'test-key',
    headers: { 'x-custom': 'vertex' },
  },
  stream: false,
  response: {
    json: {
      responseId: 'resp-vertex',
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Vertex 你好' }] },
        finishReason: 'STOP',
      }],
    },
  },
  expected: {
    url: 'https://example.test/proxy/v1beta1/publishers/google/models/test-model:generateContent',
    headers: { 'x-goog-api-key': 'test-key', 'x-custom': 'vertex' },
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    },
    outcome: {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Vertex 你好' }],
        toolCalls: [],
      },
      messageId: 'resp-vertex',
    },
  },
} satisfies GoogleGenAITransportFixture;
