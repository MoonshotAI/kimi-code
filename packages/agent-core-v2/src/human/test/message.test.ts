import { describe, expect, it } from 'vitest';

import { fromCorePart, toCorePart } from '#/message';

describe('core message conversion', () => {
  it('preserves MIME parameters on media data URLs', () => {
    const url = 'data:video/mp4;codecs=avc1;base64,AQID';
    const core = toCorePart({ type: 'video_url', videoUrl: { url } });
    const legacy = fromCorePart(core);
    if (legacy.type !== 'video_url') throw new Error('expected a video part');
    expect(legacy.videoUrl.url).toBe(url);
  });
});
