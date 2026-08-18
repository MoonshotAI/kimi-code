import type { ContentPart } from '#/kosong/contract/message';
import { describe, expect, it } from 'vitest';

import {
  estimateTokensForContentPart,
  estimateTokensForMessage,
  estimateTokens,
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

/**
 * Calibration of `estimateTokens`' per-class divisors. Anchors measured with
 * cl100k_base on 2026-07-09 over representative tool-output / prose snippets
 * (a neutral BPE proxy — bands are wide on purpose, they pin the calibration
 * direction, not the proxy's exact counts):
 *   jsonToolOutput: 188 chars -> 78 tokens (legacy ascii/4 estimate: 47, 0.60x)
 *   toolLogLine:    136 chars -> 52 tokens (legacy: 34, 0.65x)
 *   englishProse:    82 chars -> 14 tokens (legacy: 21, 1.50x; over-estimating
 *                   prose is tolerated — it biases the budget clamp toward safe)
 */
describe('estimateTokens character-class calibration', () => {
  const jsonToolOutput = `{
  "name": "kimi-code",
  "version": "1.2.3",
  "flags": {"spine": true, "experimental": false},
  "items": [1, 2, 3, {"nested": null, "ratio": 0.75}],
  "retry": {"max": 5, "ok": true}
}`;
  const toolLogLine =
    '[2026-07-09T12:22:35.000Z] ERROR worker=3 req_id=9f3ab2 attempt=2/5 status=500 latency=1842ms upstream=api.example.test code=ECONNRESET\n';
  const englishProse =
    'The context size service keeps a measured prefix and estimates the remaining tail.';

  const legacyEstimate = (text: string): number => {
    let ascii = 0;
    let total = 0;
    for (const char of text) {
      total += 1;
      if (char.codePointAt(0)! <= 127) ascii += 1;
    }
    return Math.ceil(ascii / 4) + (total - ascii);
  };

  it('returns zero for empty text and at least one token for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens(' ')).toBeGreaterThanOrEqual(1);
  });

  it('counts symbol/digit runs denser than word runs and whitespace runs sparser', () => {
    const dense = estimateTokens('=/'.repeat(32));
    const words = estimateTokens('a'.repeat(64));
    const whitespace = estimateTokens(' '.repeat(64));

    expect(dense).toBeGreaterThan(words * 1.5);
    expect(whitespace).toBeLessThan(words);
  });

  it('keeps one token per non-ascii character', () => {
    expect(estimateTokens('汉字测试')).toBe(4);
  });

  it('stays within the measured band for pretty JSON tool output', () => {
    const estimate = estimateTokens(jsonToolOutput);
    const actual = 78;

    expect(estimate).toBeGreaterThanOrEqual(actual * 0.7);
    expect(estimate).toBeLessThanOrEqual(actual * 1.15);
    expect(estimate).toBeGreaterThanOrEqual(legacyEstimate(jsonToolOutput) * 1.25);
  });

  it('stays within the measured band for dense log tool output', () => {
    const estimate = estimateTokens(toolLogLine);
    const actual = 52;

    expect(estimate).toBeGreaterThanOrEqual(actual * 0.75);
    expect(estimate).toBeLessThanOrEqual(actual * 1.2);
    expect(estimate).toBeGreaterThanOrEqual(legacyEstimate(toolLogLine) * 1.25);
  });

  it('never under-estimates plain prose', () => {
    const actual = 14;

    expect(estimateTokens(englishProse)).toBeGreaterThanOrEqual(actual);
    expect(estimateTokens(englishProse)).toBeLessThanOrEqual(actual * 2);
  });
});
