import { testModule } from '../../../harness';
import type { GoogleGenAITransportFixture } from '../types';

export default {
  name: 'vertex-adc-non-stream',
  module: testModule({
    options: { vertexai: true, project: 'test-project', location: 'test-location' },
  }),
  endpoint: {
    baseUrl: 'https://example.test/proxy/v1beta1/',
    headers: { 'x-custom': 'vertex' },
  },
  stream: false,
  response: {
    json: {
      responseId: 'resp-vertex-adc',
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Vertex ADC 你好' }] },
        finishReason: 'STOP',
      }],
    },
  },
  expected: {
    url: 'https://example.test/proxy/v1beta1/projects/test-project/locations/test-location/publishers/google/models/test-model:generateContent',
    headers: { 'x-custom': 'vertex' },
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    },
    outcome: {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Vertex ADC 你好' }],
        toolCalls: [],
      },
      messageId: 'resp-vertex-adc',
    },
  },
} satisfies GoogleGenAITransportFixture;
