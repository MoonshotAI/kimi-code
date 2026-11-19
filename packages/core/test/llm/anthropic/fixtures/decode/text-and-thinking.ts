import type { AnthropicDecodeFixture } from '../types';

const startUsage = {
  input_tokens: 10,
  output_tokens: 1,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 1,
};
const fullUsage = { ...startUsage, output_tokens: 3 };

export default {
  name: 'text-and-thinking',
  chunks: [
    { type: 'message_start', message: { id: 'msg-1', usage: startUsage } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: 'reason' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signature-1' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Hello' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  ],
  expected: [
    { type: 'messageId', messageId: 'msg-1' },
    {
      type: 'usage',
      usage: {
        inputOther: 10,
        inputCacheRead: 2,
        inputCacheCreation: 1,
        raw: startUsage,
      },
    },
    { type: 'part', part: { type: 'think', think: 'reason' } },
    { type: 'part', part: { type: 'think', think: '', encrypted: 'signature-1' } },
    { type: 'part', part: { type: 'text', text: 'Hello' } },
    { type: 'usage', usage: { output: 3, raw: { output_tokens: 3 } } },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'end_turn' } },
  ],
  replay: {
    response: {
      id: 'msg-1',
      stop_reason: 'end_turn',
      usage: fullUsage,
      content: [
        { type: 'thinking', thinking: 'reason', signature: 'signature-1' },
        { type: 'text', text: 'Hello' },
      ],
    },
    expected: [
      { type: 'messageId', messageId: 'msg-1' },
      { type: 'part', part: { type: 'think', think: 'reason' } },
      { type: 'part', part: { type: 'think', think: '', encrypted: 'signature-1' } },
      { type: 'part', part: { type: 'text', text: 'Hello' } },
      {
        type: 'usage',
        usage: {
          inputOther: 10,
          inputCacheRead: 2,
          inputCacheCreation: 1,
          output: 3,
          raw: fullUsage,
        },
      },
      { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'end_turn' } },
    ],
  },
} satisfies AnthropicDecodeFixture;
