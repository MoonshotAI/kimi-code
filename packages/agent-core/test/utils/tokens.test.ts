import type { ContentPart } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  estimateTokensForContentPart,
  estimateTokensForMessage,
  MEDIA_TOKEN_ESTIMATE,
} from '../../src/utils/tokens';

// Regression coverage for CMP-03: media content parts (image/audio/video) must
// NOT estimate to 0 tokens. When they did, compaction triggers, the
// overflow-shrink budget, the kept-user 20k budget, and the reported
// `tokensAfter` all went blind to the single largest context contributor (a
// base64 image data URL), so a vision-heavy session could overflow the provider
// while the estimator reported a near-empty context.
describe('estimateTokensForContentPart — media parts', () => {
  const imagePart: ContentPart = {
    type: 'image_url',
    imageUrl: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
  };
  const audioPart: ContentPart = {
    type: 'audio_url',
    audioUrl: { url: 'data:audio/mp3;base64,AAAA' },
  };
  const videoPart: ContentPart = {
    type: 'video_url',
    videoUrl: { url: 'data:video/mp4;base64,AAAA' },
  };

  it('estimates an image part as a substantial, non-zero token cost', () => {
    expect(estimateTokensForContentPart(imagePart)).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(MEDIA_TOKEN_ESTIMATE).toBeGreaterThan(100);
  });

  it('estimates audio and video parts as non-zero', () => {
    expect(estimateTokensForContentPart(audioPart)).toBeGreaterThan(0);
    expect(estimateTokensForContentPart(videoPart)).toBeGreaterThan(0);
  });

  it('uses a bounded fixed estimate, not the base64 payload length', () => {
    // A ~4 MB base64 data URL must not be counted as text (which would yield
    // ~1M "tokens"); the estimate must stay a small bounded value.
    const huge = 'A'.repeat(4_000_000);
    const bigImage: ContentPart = {
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${huge}` },
    };
    const estimate = estimateTokensForContentPart(bigImage);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(50_000);
  });

  it('includes media when estimating a whole message', () => {
    const message = {
      role: 'user',
      content: [{ type: 'text', text: 'see screenshot' }, imagePart] satisfies ContentPart[],
    };
    // The image must dominate the ~4-token text, not be free.
    expect(estimateTokensForMessage(message)).toBeGreaterThan(100);
  });
});
