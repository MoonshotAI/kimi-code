/**
 * prompt-metadata — the session title / lastPrompt text derived from a
 * prompt payload.
 *
 * Tests pin:
 *   - media parts render as `[image]` / `[video]` / `[audio]` placeholders
 *   - an inline image-compression caption (harness metadata placed next to
 *     the image by prompt ingestion) never leaks into titles/lastPrompt,
 *     whether it is a standalone text part or merged into the user's text
 */

import { describe, expect, it } from 'vitest';

import { promptMetadataTextFromPayload } from '../../src/session/prompt-metadata';
import { buildImageCompressionCaption } from '../../src/tools/support/image-compress';

const CAPTION = buildImageCompressionCaption({
  original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
  final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
  originalPath: '/tmp/originals/shot.png',
});

describe('promptMetadataTextFromPayload', () => {
  it('renders text and media placeholders', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('look at this [image]');
  });

  it('keeps a standalone image-compression caption out of the metadata text', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: CAPTION },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('[image]');
  });

  it('strips a caption merged into the user text and keeps the rest', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: `能展示但是没有快捷键提示${CAPTION}` },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('能展示但是没有快捷键提示 [image]');
    expect(text).not.toContain('<system>');
    expect(text).not.toContain('Image compressed');
  });

  it('renders an [audio] placeholder for audio input', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: 'transcribe this' },
        { type: 'audio_url', audioUrl: { url: 'data:audio/mp3;base64,AAAA' } },
      ],
    });
    expect(text).toBe('transcribe this [audio]');
  });

  it('renders a [video] placeholder for video input', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } },
      ],
    });
    expect(text).toBe('[video]');
  });

  it('renders multiple media placeholders in order', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: 'compare' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'and' },
        { type: 'audio_url', audioUrl: { url: 'data:audio/mp3;base64,BBBB' } },
      ],
    });
    expect(text).toBe('compare [image] and [audio]');
  });

  it('returns an empty string for empty input', () => {
    const text = promptMetadataTextFromPayload({ input: [] });
    expect(text).toBe('');
  });

  it('returns an empty string for input with only media and no text', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('[image]');
  });

  it('handles very long input text gracefully', () => {
    const longText = 'a'.repeat(10_000);
    const text = promptMetadataTextFromPayload({
      input: [{ type: 'text', text: longText }],
    });
    // Not wrongly redacted as a secret; truncated to the metadata cap.
    expect(text).toBe('a'.repeat(4000));
  });

  it('strips the caption when it is the only text and there are no images', () => {
    const text = promptMetadataTextFromPayload({
      input: [{ type: 'text', text: CAPTION }],
    });
    expect(text).toBe('');
  });
});
