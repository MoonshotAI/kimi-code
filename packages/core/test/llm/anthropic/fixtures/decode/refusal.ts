import type { AnthropicDecodeFixture } from '../types';

export default {
  name: 'refusal',
  chunks: [{ type: 'message_delta', delta: { stop_reason: 'refusal' } }],
  expected: [{
    type: 'finish',
    finish: { finishReason: 'filtered', rawFinishReason: 'refusal' },
  }],
  replay: {
    response: { stop_reason: 'refusal' },
  },
} satisfies AnthropicDecodeFixture;
