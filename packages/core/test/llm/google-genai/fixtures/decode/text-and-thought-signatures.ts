import type { GoogleGenAIDecodeFixture } from '../types';

const usageMetadata = {
  promptTokenCount: 10,
  cachedContentTokenCount: 2,
  candidatesTokenCount: 3,
};
const response = {
  responseId: 'resp-google',
  candidates: [{
    content: {
      role: 'model',
      parts: [
        { text: 'answer', thoughtSignature: 'sig-text' },
        { text: 'reason', thought: true, thoughtSignature: 'sig-think' },
      ],
    },
    finishReason: 'STOP',
  }],
  usageMetadata,
};

export default {
  name: 'text-and-thought-signatures',
  chunks: [response],
  expected: [
    { type: 'messageId', messageId: 'resp-google' },
    {
      type: 'usage',
      usage: {
        inputOther: 8,
        output: 3,
        inputCacheRead: 2,
        inputCacheCreation: 0,
        raw: usageMetadata,
      },
    },
    {
      type: 'part',
      part: { type: 'text', text: 'answer', meta: { thought_signature_b64: 'sig-text' } },
    },
    { type: 'part', part: { type: 'think', think: 'reason', encrypted: 'sig-think' } },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'STOP' } },
  ],
  replay: { response },
} satisfies GoogleGenAIDecodeFixture;
