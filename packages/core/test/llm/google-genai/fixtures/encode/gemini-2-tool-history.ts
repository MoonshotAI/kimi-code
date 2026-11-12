import { TEST_MODEL, testModule } from '../../../harness';
import type { GoogleGenAIEncodeFixture } from '../types';

export default {
  name: 'gemini-2-tool-history',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: { ...TEST_MODEL.spec, provider: 'google', name: 'gemini-2.5-flash' },
    },
    messages: [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'local_call', name: 'weather', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'local_call',
        content: [
          { type: 'text', text: 'sunny' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
          { type: 'audio_url', audioUrl: { url: 'data:audio/wav;base64,CCCC' } },
          { type: 'image_url', imageUrl: { url: 'https://example.test/a.webp' } },
        ],
      },
    ],
  }),
  expected: {
    params: {
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { id: undefined, name: 'weather', args: {} } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: undefined,
                name: 'weather',
                response: { output: 'sunny' },
                parts: undefined,
              },
            },
            { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
            { inlineData: { mimeType: 'audio/wav', data: 'CCCC' } },
            { fileData: { fileUri: 'https://example.test/a.webp', mimeType: 'image/webp' } },
          ],
        },
      ],
      config: {},
    },
  },
} satisfies GoogleGenAIEncodeFixture;
