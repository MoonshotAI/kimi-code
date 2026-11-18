import { TEST_MODEL, testModule } from '../../../harness';
import type { KimiOpenAIEncodeFixture } from '../types';

export const kimiOpenAIEncodeFixtures = [{
  name: 'kimi-openai-thinking-and-tools',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: {
        ...TEST_MODEL.spec,
        provider: 'kimi',
        name: 'kimi-for-coding',
        maxContextSize: 1000,
      },
      thinking: { effort: 'high', keep: 'all' },
    },
    profile: {
      tools: [{ name: 'weather', description: 'Get weather', parameters: { type: 'object' } }],
    },
    messages: [
      {
        role: 'system',
        content: [],
        tools: [{ name: '$builtin', description: '', parameters: { type: 'object' } }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: ' ' }],
        toolCalls: [{
          type: 'function',
          id: 'call_1',
          name: 'weather',
          arguments: '{}',
          extras: { thought_signature_b64: 'signature-1' },
        }],
      },
    ],
    usedTokens: 300,
    options: {
      extras: {
        extra_body: { nested: { enabled: true }, custom: 'inside' },
        user: 'outside',
      },
    },
  }),
  expected: {
    params: {
      model: 'kimi-for-coding',
      messages: [
        {
          role: 'system',
          tools: [{ type: 'builtin_function', function: { name: '$builtin' } }],
        },
        {
          role: 'assistant',
          reasoning_content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'weather', arguments: '{}' },
            extras: { thought_signature_b64: 'signature-1' },
          }],
        },
      ],
      tools: [{
        type: 'function',
        function: { name: 'weather', description: 'Get weather', parameters: { type: 'object' } },
      }],
      thinking: { type: 'enabled', effort: 'high', keep: 'all' },
      max_completion_tokens: 700,
      nested: { enabled: true },
      custom: 'inside',
      user: 'outside',
    },
  },
}] satisfies KimiOpenAIEncodeFixture[];
