import type { OpenAIDecodeFixture } from '../types';

export default {
  name: 'tool-arguments-before-name',
  chunks: [
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { arguments: '{"city":' } }],
        },
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { name: 'weather', arguments: '"sf"}' } }],
        },
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
        name: 'weather',
        arguments: '{"city":"sf"}',
        _streamIndex: 0,
      },
    },
    { type: 'toolCallEnd', index: 0 },
    { type: 'finish', finish: { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' } },
  ],
  replay: {
    response: {
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"sf"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
  },
} satisfies OpenAIDecodeFixture;
