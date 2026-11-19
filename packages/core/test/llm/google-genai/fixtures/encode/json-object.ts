import { testModule } from '../../../harness';
import type { GoogleGenAIEncodeFixture } from '../types';

export default {
  name: 'json-object',
  module: testModule({
    model: {
      spec: { provider: 'google', name: 'gemini-3-pro-preview' },
      responseFormat: { type: 'json_object' },
    },
  }),
  expected: {
    params: {
      model: 'gemini-3-pro-preview',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      config: { responseMimeType: 'application/json' },
    },
  },
} satisfies GoogleGenAIEncodeFixture;
