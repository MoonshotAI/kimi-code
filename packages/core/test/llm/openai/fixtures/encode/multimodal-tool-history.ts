import { testModule } from '../../../harness';
import type { OpenAIEncodeFixture } from '../types';

export default {
  name: 'multimodal-tool-history',
  module: testModule({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look and listen' },
          { type: 'image_url', imageUrl: { url: 'https://example.test/a.png', id: 'image-1' } },
          { type: 'audio_url', audioUrl: { url: 'data:audio/wav;base64,AAAA' } },
          { type: 'video_url', videoUrl: { url: 'https://example.test/a.mp4' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'Need weather' },
          { type: 'text', text: 'Checking' },
        ],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'weather', arguments: '{"city":"sf"}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        content: [
          { type: 'text', text: 'sunny' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,BBBB' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
    ],
  }),
  expected: {
    params: {
      model: 'test-model',
      reasoning_effort: 'medium',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look and listen' },
            { type: 'image_url', image_url: { url: 'https://example.test/a.png', id: 'image-1' } },
            { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,AAAA' } },
            { type: 'video_url', video_url: { url: 'https://example.test/a.mp4' } },
          ],
        },
        {
          role: 'assistant',
          content: 'Checking',
          reasoning_content: 'Need weather',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"sf"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Attached media from tool result:' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
          ],
        },
        { role: 'user', content: 'Thanks' },
      ],
    },
  },
} satisfies OpenAIEncodeFixture;
