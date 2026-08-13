/**
 * promptMetadataText — the session title / lastPrompt text derived from
 * prompt content parts.
 *
 * Tests pin:
 *   - media parts render as `[image]` / `[video]` / `[audio]` placeholders
 *   - an inline image-compression caption (harness metadata placed next to
 *     the image by prompt ingestion) never leaks into titles/lastPrompt,
 *     whether it is a standalone text part or merged into the user's text
 *   - prompt metadata updates retain the latest sanitized prompt and derive
 *     the easy title
 */

import { describe, expect, it } from 'vitest';

import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import {
  applyPromptMetadataUpdate,
  type PromptMetadataUpdateTarget,
} from '#/session/sessionMetadata/promptMetadata';
import { buildImageCompressionCaption } from '#/agent/media/image-compress';
import type { IEventService } from '#/app/event/event';
import {
  type ISessionMetadata,
  type SessionMeta,
  type SessionMetaPatch,
} from '#/session/sessionMetadata/sessionMetadata';

const CAPTION = buildImageCompressionCaption({
  original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
  final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
  originalPath: '/tmp/originals/shot.png',
});

describe('promptMetadataTextFromContentParts', () => {
  it('renders text and media placeholders', () => {
    const text = promptMetadataTextFromContentParts([
      { type: 'text', text: 'look at this' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(text).toBe('look at this [image]');
  });

  it('keeps a standalone image-compression caption out of the metadata text', () => {
    const text = promptMetadataTextFromContentParts([
      { type: 'text', text: CAPTION },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(text).toBe('[image]');
  });

  it('strips a caption merged into the user text and keeps the rest', () => {
    const text = promptMetadataTextFromContentParts([
      { type: 'text', text: `能展示但是没有快捷键提示${CAPTION}` },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(text).toBe('能展示但是没有快捷键提示 [image]');
    expect(text).not.toContain('<system>');
    expect(text).not.toContain('Image compressed');
  });
});

describe('applyPromptMetadataUpdate', () => {
  function createTarget(initial: Partial<SessionMeta> = {}) {
    let meta: SessionMeta = {
      id: 'sess-1',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      ...initial,
    };
    const target: PromptMetadataUpdateTarget = {
      metadata: {
        read: () => Promise.resolve(meta),
        update: (patch: SessionMetaPatch) => {
          meta = { ...meta, ...patch };
          return Promise.resolve();
        },
      } as unknown as ISessionMetadata,
      eventService: { publish: () => undefined } as unknown as IEventService,
      sessionId: 'sess-1',
    };
    return { target, readMeta: () => meta };
  }

  it('updates the latest prompt and derives the easy title', async () => {
    const { target, readMeta } = createTarget();

    await applyPromptMetadataUpdate(target, '第一条');
    await applyPromptMetadataUpdate(target, '第二条');

    expect(readMeta().lastPrompt).toBe('第二条');
    expect(readMeta().title).toBe('第一条');
    expect(readMeta().titleKind).toBe('replaceable');
  });

  it('updates metadata for slash activations', async () => {
    const { target, readMeta } = createTarget();

    await applyPromptMetadataUpdate(target, '/compact');

    expect(readMeta().lastPrompt).toBe('/compact');
    expect(readMeta().title).toBe('/compact');
  });
});
