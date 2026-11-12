import { TEST_MODEL, testModule } from '../../../harness';
import type { KimiAnthropicEncodeFixture } from '../types';

export const kimiAnthropicEncodeFixtures = [{
  name: 'kimi-anthropic-thinking-and-heic',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: { ...TEST_MODEL.spec, provider: 'kimi', name: 'kimi-for-coding' },
      thinking: { effort: 'high', keep: 'all' },
    },
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url: 'data:image/heic;base64,AAAA' } }],
    }],
  }),
  expected: {
    params: {
      model: 'kimi-for-coding',
      max_tokens: 64_000,
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
      context_management: {
        edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
      },
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', data: 'AAAA', media_type: 'image/heic' },
          cache_control: { type: 'ephemeral' },
        }],
      }],
      betas: ['context-management-2025-06-27'],
    },
    betas: ['context-management-2025-06-27'],
    useBetaApi: true,
  },
}] satisfies KimiAnthropicEncodeFixture[];
