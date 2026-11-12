import type { OpenAIResponsesDecodeFixture } from '../types';

const usage = {
  input_tokens: 10,
  output_tokens: 3,
  input_tokens_details: { cached_tokens: 2 },
};

export default {
  name: 'text-and-reasoning',
  chunks: [
    { type: 'response.reasoning_summary_part.added' },
    { type: 'response.reasoning_summary_text.delta', delta: 'reason' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', summary: [], encrypted_content: 'encrypted-1' },
    },
    { type: 'response.output_text.delta', delta: 'Hello' },
    {
      type: 'response.completed',
      response: { id: 'resp-1', status: 'completed', usage },
    },
  ],
  expected: [
    { type: 'part', part: { type: 'think', think: '' } },
    { type: 'part', part: { type: 'think', think: 'reason' } },
    { type: 'part', part: { type: 'think', think: '', encrypted: 'encrypted-1' } },
    { type: 'part', part: { type: 'text', text: 'Hello' } },
    { type: 'messageId', messageId: 'resp-1' },
    {
      type: 'usage',
      usage: {
        inputOther: 8,
        output: 3,
        inputCacheRead: 2,
        inputCacheCreation: 0,
        raw: usage,
      },
    },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'completed' } },
  ],
  replay: {
    response: {
      id: 'resp-1',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'reason' }],
          encrypted_content: 'encrypted-1',
        },
        { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
      ],
      usage,
    },
    expected: [
      { type: 'part', part: { type: 'think', think: 'reason' } },
      { type: 'part', part: { type: 'think', think: '', encrypted: 'encrypted-1' } },
      { type: 'part', part: { type: 'text', text: 'Hello' } },
      { type: 'messageId', messageId: 'resp-1' },
      {
        type: 'usage',
        usage: {
          inputOther: 8,
          output: 3,
          inputCacheRead: 2,
          inputCacheCreation: 0,
          raw: usage,
        },
      },
      { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'completed' } },
    ],
  },
} satisfies OpenAIResponsesDecodeFixture;
