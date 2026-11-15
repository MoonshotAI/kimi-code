import type { AnthropicDecodeFixture } from '../types';

export default {
  name: 'tool-use-fragments',
  chunks: [
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'call_1', name: 'weather' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"city":' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '"sf"}' },
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ],
  expected: [
    {
      type: 'part',
      part: {
        type: 'function',
        id: 'call_1',
        name: 'weather',
        arguments: '',
        _streamIndex: 2,
      },
    },
    { type: 'part', part: { type: 'tool_call_part', argumentsPart: '{"city":', index: 2 } },
    { type: 'part', part: { type: 'tool_call_part', argumentsPart: '"sf"}', index: 2 } },
    { type: 'toolCallEnd', index: 2 },
    { type: 'finish', finish: { finishReason: 'tool_calls', rawFinishReason: 'tool_use' } },
  ],
  replay: {
    response: {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'sf' } }],
    },
    expected: [
      {
        type: 'part',
        part: {
          type: 'function',
          id: 'call_1',
          name: 'weather',
          arguments: '',
          _streamIndex: 0,
        },
      },
      {
        type: 'part',
        part: { type: 'tool_call_part', argumentsPart: '{"city":"sf"}', index: 0 },
      },
      { type: 'toolCallEnd', index: 0 },
      { type: 'finish', finish: { finishReason: 'tool_calls', rawFinishReason: 'tool_use' } },
    ],
  },
} satisfies AnthropicDecodeFixture;
