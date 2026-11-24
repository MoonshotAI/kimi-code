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
      cacheKey: 'cache-1',
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
      prompt_cache_key: 'cache-1',
      max_completion_tokens: 700,
      nested: { enabled: true },
      custom: 'inside',
      user: 'outside',
    },
  },
}, {
  name: 'kimi-openai-empty-text-cleanup',
  module: testModule({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '', meta: { thought_signature_b64: 'gemini-signature' } },
          { type: 'text', text: 'first' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }, { type: 'text', text: '   ' }],
        toolCalls: [{
          type: 'function',
          id: 'call_empty',
          name: 'weather',
          arguments: '{}',
        }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '' }],
        toolCallId: 'call_empty',
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: ' ' }, { type: 'text', text: 'Compact this conversation.' }],
      },
    ],
  }),
  expected: {
    params: {
      model: 'test-model',
      messages: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_empty',
            type: 'function',
            function: { name: 'weather', arguments: '{}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_empty',
          content: '<system>Tool output is empty.</system>',
        },
        { role: 'user', content: 'Compact this conversation.' },
      ],
    },
  },
}, {
  name: 'kimi-openai-cache-key',
  module: testModule({
    model: { ...TEST_MODEL, cacheKey: 'kimi-cache-1' },
  }),
  expected: {
    params: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      prompt_cache_key: 'kimi-cache-1',
    },
  },
}] satisfies KimiOpenAIEncodeFixture[];
