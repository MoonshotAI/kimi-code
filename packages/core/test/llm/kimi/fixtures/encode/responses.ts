import { TEST_MODEL, testModule } from '../../../harness';
import type { KimiResponsesEncodeFixture } from '../types';

export const kimiResponsesEncodeFixtures = [{
  name: 'kimi-responses-remaining-output-cap',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: {
        ...TEST_MODEL.spec,
        provider: 'kimi',
        name: 'kimi-for-coding',
        maxContextSize: 1000,
      },
    },
    usedTokens: 300,
  }),
  expected: {
    params: {
      model: 'kimi-for-coding',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      store: false,
      max_output_tokens: 700,
    },
  },
}] satisfies KimiResponsesEncodeFixture[];
