import { testModule } from '../../../harness';
import type { AnthropicEncodeFixture } from '../types';

export default {
  name: 'thinking-tool-history',
  module: testModule({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'reason', encrypted: 'signature-1' },
          { type: 'text', text: 'Checking' },
          { type: 'text', text: '', meta: { thought_signature_b64: 'other-provider' } },
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
      max_tokens: 64_000,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reason', signature: 'signature-1' },
            { type: 'text', text: 'Checking' },
            { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'sf' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [
                { type: 'text', text: 'sunny' },
                { type: 'image', source: { type: 'base64', data: 'BBBB', media_type: 'image/png' } },
              ],
            },
            { type: 'text', text: 'Thanks', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    },
    betas: ['interleaved-thinking-2025-05-14'],
    useBetaApi: false,
  },
} satisfies AnthropicEncodeFixture;
