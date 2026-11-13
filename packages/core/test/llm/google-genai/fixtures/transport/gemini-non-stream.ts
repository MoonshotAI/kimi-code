import { testModule } from '../../../harness';
import type { GoogleGenAITransportFixture } from '../types';

export default {
  name: 'gemini-non-stream',
  module: testModule(),
  endpoint: { baseUrl: 'https://example.test/v1beta/', apiKey: 'test-key' },
  stream: false,
  response: {
    json: {
      responseId: 'resp-gemini-non-stream',
      candidates: [{
        content: { role: 'model', parts: [{ text: '非流式 Gemini' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    },
  },
  expected: {
    url: 'https://example.test/v1beta/models/test-model:generateContent',
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    },
    outcome: {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '非流式 Gemini' }],
        toolCalls: [],
      },
      usage: { inputOther: 5, output: 2 },
      messageId: 'resp-gemini-non-stream',
    },
  },
} satisfies GoogleGenAITransportFixture;
