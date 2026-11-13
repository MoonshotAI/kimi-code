import type { OpenAIResponsesDecodeFixture } from '../types';

export default {
  name: 'incomplete-max-output-tokens',
  chunks: [
    { type: 'response.output_text.delta', delta: 'partial' },
    {
      type: 'response.incomplete',
      response: {
        id: 'resp-incomplete',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    },
  ],
  expected: [
    { type: 'part', part: { type: 'text', text: 'partial' } },
    { type: 'messageId', messageId: 'resp-incomplete' },
    {
      type: 'finish',
      finish: { finishReason: 'truncated', rawFinishReason: 'max_output_tokens' },
    },
  ],
  replay: {
    response: {
      id: 'resp-incomplete',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
    },
  },
} satisfies OpenAIResponsesDecodeFixture;
