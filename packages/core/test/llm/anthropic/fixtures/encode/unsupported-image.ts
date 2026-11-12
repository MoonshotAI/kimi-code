import { testModule } from '../../../harness';
import type { AnthropicEncodeFixture } from '../types';

export default {
  name: 'unsupported-image',
  module: testModule({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url: 'data:image/heic;base64,AAAA' } }],
    }],
  }),
  expectedError: /Unsupported media type for base64 image: image\/heic/,
} satisfies AnthropicEncodeFixture;
