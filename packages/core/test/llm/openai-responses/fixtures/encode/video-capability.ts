import { TEST_MODEL, testModule } from '../../../harness';
import type { OpenAIResponsesEncodeFixture } from '../types';

const videoMessages = [
  {
    role: 'user' as const,
    content: [
      { type: 'video_url' as const, videoUrl: { url: 'data:video/mp4;base64,AQID' } },
      { type: 'video_url' as const, videoUrl: { url: 'ms://file-1', id: 'file-1' } },
      { type: 'video_url' as const, videoUrl: { url: 'data:video/x-ms-wmv;base64,AQID' } },
      { type: 'video_url' as const, videoUrl: { url: 'data:video/mp4;codecs=avc1;base64,AQID' } },
    ],
  },
];

export const videoInlineFixture = {
  name: 'video-capability-inline',
  module: testModule({ messages: videoMessages }),
  expected: {
    params: {
      model: 'test-model',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_file', file_data: 'data:video/mp4;base64,AQID', filename: 'inline.mp4' },
            { type: 'input_file', file_url: 'ms://file-1' },
            { type: 'input_file', file_data: 'data:video/x-ms-wmv;base64,AQID', filename: 'inline.wmv' },
            { type: 'input_file', file_data: 'data:video/mp4;codecs=avc1;base64,AQID', filename: 'inline.mp4' },
          ],
        },
      ],
      store: false,
    },
  },
} satisfies OpenAIResponsesEncodeFixture;

export const videoOmittedFixture = {
  name: 'video-capability-omitted',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: {
        ...TEST_MODEL.spec,
        capability: { ...TEST_MODEL.spec.capability, video_in: false },
      },
    },
    messages: videoMessages,
  }),
  expected: {
    params: {
      model: 'test-model',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '(video omitted: not supported by this provider)' },
            { type: 'input_text', text: '(video omitted: not supported by this provider)' },
            { type: 'input_text', text: '(video omitted: not supported by this provider)' },
            { type: 'input_text', text: '(video omitted: not supported by this provider)' },
          ],
        },
      ],
      store: false,
    },
  },
} satisfies OpenAIResponsesEncodeFixture;
