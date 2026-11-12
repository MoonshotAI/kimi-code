import { testModule } from '../../../harness';
import type { OpenAIEncodeFixture } from '../types';

export default {
  name: 'reasoning-details',
  module: testModule({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'think', think: 'summary', detailsIndex: 0 },
        { type: 'think', think: '', encrypted: 'encrypted-1', detailsIndex: 0 },
        { type: 'text', text: 'Answer' },
      ],
      toolCalls: [],
    }],
  }),
  expected: {
    params: {
      model: 'test-model',
      reasoning_effort: 'medium',
      messages: [{
        role: 'assistant',
        content: 'Answer',
        tool_calls: undefined,
        reasoning_content: 'summary',
        reasoning_details: [
          { type: 'summary', summary: 'summary' },
          { type: 'encrypted', encrypted: 'encrypted-1' },
        ],
      }],
    },
  },
} satisfies OpenAIEncodeFixture;
