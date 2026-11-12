import type { OpenAIResponsesDecodeFixture } from '../types';

export default {
  name: 'invalid-function-arguments',
  chunks: [{
    type: 'response.function_call_arguments.delta',
    item_id: 'missing-item',
    delta: '{}',
  }],
  expectedError: /unknown stream index missing-item/,
} satisfies OpenAIResponsesDecodeFixture;
