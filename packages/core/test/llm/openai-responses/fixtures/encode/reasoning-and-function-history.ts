import { testModule } from '../../../harness';
import type { OpenAIResponsesEncodeFixture } from '../types';

export default {
  name: 'reasoning-and-function-history',
  module: testModule({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking' },
          { type: 'think', think: 'reason', encrypted: 'encrypted-1' },
        ],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'weather', arguments: '{"city":"sf"}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        content: [
          { type: 'text', text: 'sunny' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,BBBB' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
    ],
  }),
  expected: {
    params: {
      model: 'test-model',
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking', annotations: [] }],
        },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'reason' }],
          encrypted_content: 'encrypted-1',
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'weather',
          arguments: '{"city":"sf"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [
            { type: 'input_text', text: 'sunny' },
            { type: 'input_image', image_url: 'data:image/png;base64,BBBB' },
          ],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Thanks' }],
        },
      ],
      store: false,
    },
  },
} satisfies OpenAIResponsesEncodeFixture;
