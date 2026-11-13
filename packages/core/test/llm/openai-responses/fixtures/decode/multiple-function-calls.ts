import type { OpenAIResponsesDecodeFixture } from '../types';

export default {
  name: 'multiple-function-calls',
  chunks: [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'first', arguments: '{}' },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'first', arguments: '{}' },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'item_2', call_id: 'call_2', name: 'second', arguments: '{"x":1}' },
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: { type: 'function_call', id: 'item_2', call_id: 'call_2', name: 'second', arguments: '{"x":1}' },
    },
    { type: 'response.completed', response: { status: 'completed' } },
  ],
  expected: [
    {
      type: 'part',
      part: {
        type: 'function',
        id: 'call_1',
        name: 'first',
        arguments: '{}',
        _streamIndex: 'item_1',
      },
    },
    { type: 'toolCallEnd', index: 'item_1' },
    {
      type: 'part',
      part: {
        type: 'function',
        id: 'call_2',
        name: 'second',
        arguments: '{"x":1}',
        _streamIndex: 'item_2',
      },
    },
    { type: 'toolCallEnd', index: 'item_2' },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'completed' } },
  ],
  replay: {
    response: {
      output: [
        { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'first', arguments: '{}' },
        { type: 'function_call', id: 'item_2', call_id: 'call_2', name: 'second', arguments: '{"x":1}' },
      ],
    },
  },
} satisfies OpenAIResponsesDecodeFixture;
