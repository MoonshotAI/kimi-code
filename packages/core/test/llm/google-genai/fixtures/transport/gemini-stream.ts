import { testModule } from '../../../harness';
import type { GoogleGenAITransportFixture } from '../types';

export default {
  name: 'gemini-stream',
  module: testModule(),
  endpoint: {
    baseUrl: 'https://example.test/v1beta',
    apiKey: 'test-key',
    headers: { 'x-custom': 'custom' },
  },
  response: {
    sse: {
      done: false,
      events: [{
        responseId: 'resp-gemini-stream',
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Gemini 你好' }] },
          finishReason: 'STOP',
        }],
      }],
    },
  },
  expected: {
    url: 'https://example.test/v1beta/models/test-model:streamGenerateContent?alt=sse',
    headers: { 'x-goog-api-key': 'test-key', 'x-custom': 'custom' },
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    },
    outcome: {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Gemini 你好' }],
        toolCalls: [],
      },
      finish: { finishReason: 'completed', rawFinishReason: 'STOP' },
      messageId: 'resp-gemini-stream',
    },
  },
} satisfies GoogleGenAITransportFixture;
