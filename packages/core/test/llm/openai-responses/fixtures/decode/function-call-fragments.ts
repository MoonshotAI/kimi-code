import type { OpenAIResponsesDecodeFixture } from '../types';

const item = {
  type: 'function_call',
  id: 'item_1',
  call_id: 'call_1',
  name: 'weather',
  arguments: '',
};

export default {
  name: 'function-call-fragments',
  chunks: [
    { type: 'response.output_item.added', output_index: 1, item },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'item_1',
      output_index: 1,
      delta: '{"city":',
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'item_1',
      output_index: 1,
      delta: '"sf"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: { ...item, arguments: '{"city":"sf"}' },
    },
    { type: 'response.completed', response: { id: 'resp-1', status: 'completed' } },
  ],
  expected: [
    {
      type: 'part',
      part: {
        type: 'function',
        id: 'call_1',
        name: 'weather',
        arguments: '',
        _streamIndex: 'item_1',
      },
    },
    {
      type: 'part',
      part: { type: 'tool_call_part', argumentsPart: '{"city":', index: 'item_1' },
    },
    {
      type: 'part',
      part: { type: 'tool_call_part', argumentsPart: '"sf"}', index: 'item_1' },
    },
    { type: 'toolCallEnd', index: 'item_1' },
    { type: 'messageId', messageId: 'resp-1' },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'completed' } },
  ],
  replay: {
    response: {
      id: 'resp-1',
      status: 'completed',
      output: [{ ...item, arguments: '{"city":"sf"}' }],
    },
    expected: [
      {
        type: 'part',
        part: {
          type: 'function',
          id: 'call_1',
          name: 'weather',
          arguments: '{"city":"sf"}',
          _streamIndex: 'item_1',
        },
      },
      { type: 'toolCallEnd', index: 'item_1' },
      { type: 'messageId', messageId: 'resp-1' },
      { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'completed' } },
    ],
  },
} satisfies OpenAIResponsesDecodeFixture;
