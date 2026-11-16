import type { AnthropicDecodeFixture } from '../types';

export default {
  name: 'redacted-thinking',
  chunks: [{
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'redacted_thinking', data: 'encrypted-1' },
  }],
  expected: [{
    type: 'part',
    part: { type: 'think', think: '', encrypted: 'encrypted-1' },
  }],
  replay: {
    response: {
      content: [{ type: 'redacted_thinking', data: 'encrypted-1' }],
    },
  },
} satisfies AnthropicDecodeFixture;
