import { testModule } from '../../../harness';
import type { OpenAIResponsesEncodeFixture } from '../types';

export default {
  name: 'unsupported-audio',
  module: testModule({
    messages: [{
      role: 'user',
      content: [
        { type: 'audio_url', audioUrl: { url: 'data:audio/ogg;base64,AAAA' } },
        { type: 'audio_url', audioUrl: { url: 'ms://file/audio-1' } },
      ],
    }],
  }),
  expected: {
    params: {
      model: 'test-model',
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '(audio omitted: unsupported audio format)' },
          { type: 'input_text', text: '(audio omitted: unsupported audio format)' },
        ],
      }],
      store: false,
    },
  },
} satisfies OpenAIResponsesEncodeFixture;
