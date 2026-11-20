import { testModule } from '../../../harness';
import type { OpenAIEncodeFixture } from '../types';

export default {
  name: 'response-format-and-tool-text',
  module: testModule({
    model: {
      spec: { provider: 'openai', name: 'test-model' },
      responseFormat: { type: 'json_object' },
    },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [],
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
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'snap', arguments: '{}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'shot taken\n(image omitted: tool result converted to plain text)',
        },
      ],
      response_format: { type: 'json_object' },
    },
  },
} satisfies OpenAIEncodeFixture;
