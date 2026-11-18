import { TEST_MODEL, testModule } from '../../../harness';
import type { AnthropicEncodeFixture } from '../types';

export default {
  name: 'invalid-response-format',
  module: testModule({
    model: { ...TEST_MODEL, responseFormat: { type: 'json_object' } },
    messages: [],
  }),
  expectedError: /requires a JSON schema/,
} satisfies AnthropicEncodeFixture;
