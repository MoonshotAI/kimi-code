/**
 * Scenario: token estimation for rich content parts.
 * Responsibilities: media parts contribute bounded non-zero estimates to
 * content-part and whole-message estimates. Wiring: pure utility functions, no
 * collaborators. Run with:
 * `vitest run --config packages/agent-core-v2/vitest.config.ts test/_base/utils/tokens.test.ts`.
 */

import type { ContentPart } from '#/kosong/contract/message';
import { describe, expect, it } from 'vitest';

import {
  estimateTokensForContentPart,
  estimateTokensForMessage,
  MEDIA_TOKEN_ESTIMATE,
} from '#/kosong/contract/tokens';

describe('token estimates for media content parts', () => {
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

  it('counts image parts with the fixed media estimate', () => {
    expect(estimateTokensForContentPart(imagePart)).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(MEDIA_TOKEN_ESTIMATE).toBeGreaterThan(100);
  });

  it('counts audio and video parts as non-zero media', () => {
    expect(estimateTokensForContentPart(audioPart)).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(estimateTokensForContentPart(videoPart)).toBe(MEDIA_TOKEN_ESTIMATE);
  });

  it('keeps large data URLs bounded instead of counting base64 as text', () => {
    const part: ContentPart = {
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${'A'.repeat(4_000_000)}` },
    };

    expect(estimateTokensForContentPart(part)).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(estimateTokensForContentPart(part)).toBeLessThan(50_000);
  });

  it('includes media when estimating a whole message', () => {
    const estimate = estimateTokensForMessage({
      role: 'user',
      content: [{ type: 'text', text: 'see screenshot' }, imagePart],
      toolCalls: [],
    });

    expect(estimate).toBeGreaterThan(100);
  });
});
