import type { GoogleGenAIDecodeFixture } from '../types';

const response = {
  candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }],
};

export default {
  name: 'filtered',
  chunks: [response],
  expected: [{
    type: 'finish',
    finish: { finishReason: 'filtered', rawFinishReason: 'SAFETY' },
  }],
  replay: { response },
} satisfies GoogleGenAIDecodeFixture;
