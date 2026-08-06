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

import { promptMetadataTextFromPayload } from '#/agent/rpc/prompt-metadata';
import { buildImageCompressionCaption } from '#/agent/media/image-compress';

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

  it('keeps an upload <image path> tag out of the metadata text', () => {
    // The upload pair (`<image path>` tag + daemon-ref image part) folds to
    // the `[image]` placeholder — the materialization path must never leak
    // into titles / lastPrompt.
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: 'what is this?' },
        { type: 'text', text: '<image path="/Users/alice/cache/f_123.png"></image>' },
        { type: 'image_url', imageUrl: { url: 'kimi-file://f_123?path=%2FUsers%2Falice%2Fcache%2Ff_123.png' } },
      ],
    });
    expect(text).toBe('what is this? [image]');
    expect(text).not.toContain('/Users/alice');
  });

  it('keeps a bare <image path> tag as text when no ref pairs with it', () => {
    // Without a paired daemon ref the tag is not machine markup the fold may
    // claim: it stays user-visible text.
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: '<image path="/cache/f_123.png">' },
        { type: 'text', text: 'describe it' },
      ],
    });
    expect(text).toBe('<image path="/cache/f_123.png"> describe it');
  });
});
