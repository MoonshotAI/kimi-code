import { TEST_MODEL, testModule } from '../../../harness';
import type { GoogleGenAIEncodeFixture } from '../types';

export default {
  name: 'gemini-3-signatures-and-media',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: { ...TEST_MODEL.spec, provider: 'google', name: 'gemini-3-pro-preview' },
    },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer', meta: { thought_signature_b64: 'sig-text' } },
          { type: 'think', think: 'reason', encrypted: 'sig-think' },
        ],
        toolCalls: [{
          type: 'function',
          id: 'local-call',
          rawId: 'native-call',
          name: 'weather',
          arguments: '{"city":"sf"}',
          extras: { thought_signature_b64: 'sig-tool' },
        }],
      },
      {
        role: 'tool',
        toolCallId: 'local-call',
        content: [
          { type: 'text', text: 'sunny' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', imageUrl: { url: 'data:image/gif;base64,BBBB' } },
          { type: 'audio_url', audioUrl: { url: 'data:audio/wav;base64,CCCC' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
    ],
  }),
  expected: {
    params: {
      model: 'gemini-3-pro-preview',
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'answer', thoughtSignature: 'sig-text' },
            { text: 'reason', thought: true, thoughtSignature: 'sig-think' },
            {
              functionCall: { id: 'native-call', name: 'weather', args: { city: 'sf' } },
              thoughtSignature: 'sig-tool',
            },
          ],
        },
        {
          role: 'user',
          parts: [
            { text: 'Thanks' },
            {
              functionResponse: {
                id: 'native-call',
                name: 'weather',
                response: { output: 'sunny' },
                parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
              },
            },
            { inlineData: { mimeType: 'image/gif', data: 'BBBB' } },
            { inlineData: { mimeType: 'audio/wav', data: 'CCCC' } },
          ],
        },
      ],
      config: {},
    },
  },
} satisfies GoogleGenAIEncodeFixture;
