import { expect } from 'vitest';

import type { GoogleGenAIDecodeFixture } from '../types';

const response = {
  responseId: 'resp-tool',
  candidates: [{
    content: {
      role: 'model',
      parts: [{
        functionCall: { id: 'native-call', name: 'weather', args: { city: 'sf' } },
        thoughtSignature: 'sig-tool',
      }],
    },
    finishReason: 'STOP',
  }],
};

export default {
  name: 'function-call',
  chunks: [response],
  expected: [
    { type: 'messageId', messageId: 'resp-tool' },
    {
      type: 'part',
      part: {
        type: 'function',
        id: expect.stringMatching(/^weather_native-call_[0-9a-f]{8}$/),
        rawId: 'native-call',
        name: 'weather',
        arguments: '{"city":"sf"}',
        extras: { thought_signature_b64: 'sig-tool' },
      },
    },
    { type: 'toolCallEnd', index: undefined },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'STOP' } },
  ],
  replay: { response },
} satisfies GoogleGenAIDecodeFixture;
