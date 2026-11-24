import { testModule } from '../../../harness';
import type { OpenAIEncodeFixture } from '../types';

export default {
  name: 'tool-video-relocation',
  module: testModule({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading clip' }],
        toolCalls: [{ type: 'function', id: 'call_v', name: 'read_media', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call_v',
        content: [
          { type: 'text', text: 'clip ready' },
          { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AQID' } },
        ],
      },
    ],
  }),
  expected: {
    params: {
      model: 'test-model',
      messages: [
        {
          role: 'assistant',
          content: 'Reading clip',
          tool_calls: [{
            id: 'call_v',
            type: 'function',
            function: { name: 'read_media', arguments: '{}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_v', content: 'clip ready' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Attached media from tool result:' },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AQID' } },
          ],
        },
      ],
    },
  },
} satisfies OpenAIEncodeFixture;
