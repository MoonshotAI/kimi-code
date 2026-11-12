import { testModule } from '../../../harness';
import type { GoogleGenAIEncodeFixture } from '../types';

export default {
  name: 'invalid-tool-arguments',
  module: testModule({
    messages: [{
      role: 'assistant',
      content: [],
      toolCalls: [{ type: 'function', id: 'call_1', name: 'weather', arguments: 'not-json' }],
    }],
  }),
  expectedError: /must be valid JSON/,
} satisfies GoogleGenAIEncodeFixture;
