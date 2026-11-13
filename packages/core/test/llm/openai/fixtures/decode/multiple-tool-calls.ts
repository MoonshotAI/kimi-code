import type { OpenAIDecodeFixture } from '../types';

export default {
  name: 'multiple-tool-calls',
  chunks: [
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'first', arguments: '{}' } }],
        },
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 1, id: 'call_2', function: { name: 'second', arguments: '{"x":' } }],
        },
      }],
    },
    {
      choices: [{
        delta: { tool_calls: [{ index: 1, function: { arguments: '1}' } }] },
      }],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ],
  expected: [
    {
      type: 'part',
      part: {
        type: 'function',
        id: 'call_1',
        name: 'first',
        arguments: '{}',
        _streamIndex: 0,
      },
    },
    { type: 'toolCallEnd', index: 0 },
    {
      type: 'part',
      part: {
        type: 'function',
        id: 'call_2',
        name: 'second',
        arguments: '{"x":',
        _streamIndex: 1,
      },
    },
    { type: 'part', part: { type: 'tool_call_part', argumentsPart: '1}', index: 1 } },
    { type: 'toolCallEnd', index: 1 },
    { type: 'finish', finish: { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' } },
  ],
  replay: {
    response: {
      choices: [{
        message: {
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'first', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'second', arguments: '{"x":1}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    },
    expected: [
      {
        type: 'part',
        part: {
          type: 'function',
          id: 'call_1',
          name: 'first',
          arguments: '{}',
          _streamIndex: 0,
        },
      },
      { type: 'toolCallEnd', index: 0 },
      {
        type: 'part',
        part: {
          type: 'function',
          id: 'call_2',
          name: 'second',
          arguments: '{"x":1}',
          _streamIndex: 1,
        },
      },
      { type: 'toolCallEnd', index: 1 },
      { type: 'finish', finish: { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' } },
    ],
  },
} satisfies OpenAIDecodeFixture;
