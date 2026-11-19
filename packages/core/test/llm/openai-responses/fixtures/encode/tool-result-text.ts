import { testModule } from '../../../harness';
import type { OpenAIResponsesEncodeFixture } from '../types';

export default {
  name: 'tool-result-text',
  module: testModule({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Checking' }],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'snap', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        content: [
          { type: 'text', text: 'shot taken' },
          { type: 'image_url', imageUrl: { url: 'https://example.test/shot.png' } },
        ],
      },
    ],
    options: { toolMessageConversion: 'extract_text' },
  }),
  expected: {
    params: {
      model: 'test-model',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking', annotations: [] }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'snap',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'shot taken\n(image omitted: tool result converted to plain text)',
        },
      ],
      store: false,
    },
  },
} satisfies OpenAIResponsesEncodeFixture;
