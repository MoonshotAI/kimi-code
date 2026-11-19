import { describe, expect, it } from 'vitest';
import {
  attachmentReferenceName,
  ensureAttachmentMediaOrdinal,
  isDraftEntryRecoverable,
  kindSourceFor,
  nextAttachmentMediaOrdinal,
  normalizeAttachmentMediaOrdinals,
  parseClipboardAttachmentEntry,
  parseDraftAttachmentEntry,
  rebaseAttachmentMediaOrdinals,
  type AttachmentEntry,
} from '../../../src/features/attachment/entry';

function entry(attId: string, kind: AttachmentEntry['kind']): AttachmentEntry {
  return {
    attId,
    key: `blob:${attId}`,
    kind,
    name: attId,
    refCount: 1,
    uploading: false,
  };
}

describe('kindSourceFor', () => {
  it('resolves attachment kinds by id', () => {
    const source = kindSourceFor([entry('a', 'image'), entry('b', 'video')]);
    expect(source?.('a')).toBe('image');
    expect(source?.('b')).toBe('video');
    expect(source?.('missing')).toBeUndefined();
  });

  it('preserves the absence of a metadata source', () => {
    expect(kindSourceFor()).toBeUndefined();
  });
});

describe('attachment entry boundaries', () => {
  const raw = {
    attId: 'abc123',
    key: 'blob:abc123',
    kind: 'image',
    name: 'image.png',
    mediaOrdinal: 2,
    size: 42,
    mediaType: 'image/png',
    lastModified: 7,
    path: '/tmp/image.png',
    refCount: 3,
    uploading: true,
    fileId: 'file-1',
    sessionId: 'session-1',
    uploadProgress: 0.5,
    previewUrl: 'blob:preview',
    thumbnailUrl: 'data:image/jpeg;base64,dGh1bWI=',
  } as const;

  it('preserves draft ref counts and interrupts stale uploads', () => {
    expect(parseDraftAttachmentEntry(raw)).toEqual({
      attId: 'abc123',
      key: 'blob:abc123',
      kind: 'image',
      name: 'image.png',
      mediaOrdinal: 2,
      size: 42,
      mediaType: 'image/png',
      lastModified: 7,
      path: '/tmp/image.png',
      refCount: 3,
      uploading: false,
      fileId: 'file-1',
      sessionId: 'session-1',
      error: 'upload-interrupted',
      thumbnailUrl: 'data:image/jpeg;base64,dGh1bWI=',
    });
  });

  it('resets clipboard ref counts', () => {
    expect(parseClipboardAttachmentEntry(raw)?.refCount).toBe(0);
  });

  it('normalizes the unreleased mentionOrdinal draft field into mediaOrdinal', () => {
    const parsed = parseDraftAttachmentEntry({
      ...raw,
      mediaOrdinal: undefined,
      mentionOrdinal: 7,
      mentionName: 'Image 7',
    });
    expect(parsed?.mediaOrdinal).toBe(7);
    expect(parsed).not.toHaveProperty('mentionOrdinal');
    expect(parsed).not.toHaveProperty('mentionName');
  });

  it('applies the strict id alphabet only at the clipboard boundary', () => {
    const withExternalId = { ...raw, attId: 'draft:id' };
    expect(parseDraftAttachmentEntry(withExternalId)?.attId).toBe('draft:id');
    expect(parseClipboardAttachmentEntry(withExternalId)).toBeNull();
  });

  it('rejects incomplete entries at both boundaries', () => {
    expect(parseDraftAttachmentEntry({ attId: 'a' })).toBeNull();
    expect(parseClipboardAttachmentEntry({ attId: 'a' })).toBeNull();
  });

  it('drops unsafe or oversized persisted thumbnails', () => {
    expect(parseDraftAttachmentEntry({ ...raw, thumbnailUrl: 'https://example.com/thumb.jpg' })?.thumbnailUrl)
      .toBeUndefined();
    expect(parseDraftAttachmentEntry({
      ...raw,
      thumbnailUrl: `data:image/jpeg;base64,${'a'.repeat(512 * 1024)}`,
    })?.thumbnailUrl).toBeUndefined();
  });
});

describe('media ordinals', () => {
  it('allocates one stable sequence shared by images and videos', () => {
    const image = ensureAttachmentMediaOrdinal(entry('image-a', 'image'), []);
    const video = ensureAttachmentMediaOrdinal(entry('video-a', 'video'), [image]);
    const nextImage = ensureAttachmentMediaOrdinal(entry('image-b', 'image'), [image, video]);

    expect(image.mediaOrdinal).toBe(1);
    expect(video.mediaOrdinal).toBe(2);
    expect(nextImage.mediaOrdinal).toBe(3);
    expect(nextAttachmentMediaOrdinal([image, video, nextImage])).toBe(4);
  });

  it('preserves valid ordinals and repairs missing or conflicting values above the current maximum', () => {
    const normalized = normalizeAttachmentMediaOrdinals([
      entry('legacy', 'image'),
      { ...entry('kept', 'image'), mediaOrdinal: 4 },
      { ...entry('conflict', 'image'), mediaOrdinal: 4 },
      { ...entry('video', 'video'), mediaOrdinal: 1 },
    ]);

    expect(normalized.map((item) => [item.attId, item.mediaOrdinal])).toEqual([
      ['legacy', 5],
      ['kept', 4],
      ['conflict', 6],
      ['video', 1],
    ]);
  });

  it('rebases active media to rail order and moves colliding inactive tombstones above it', () => {
    const rebased = rebaseAttachmentMediaOrdinals([
      { ...entry('inactive', 'image'), mediaOrdinal: 1 },
      { ...entry('image', 'image'), mediaOrdinal: 3 },
      { ...entry('video', 'video'), mediaOrdinal: 7 },
      entry('file', 'file'),
    ], ['video', 'file', 'image']);

    expect(rebased.map((item) => [item.attId, item.mediaOrdinal])).toEqual([
      ['inactive', 3],
      ['image', 2],
      ['video', 1],
      ['file', undefined],
    ]);
  });

  it('compacts surviving media when an earlier rail item is removed', () => {
    const rebased = rebaseAttachmentMediaOrdinals([
      { ...entry('removed', 'image'), mediaOrdinal: 1 },
      { ...entry('remaining', 'video'), mediaOrdinal: 2 },
    ], ['remaining']);

    expect(rebased.map((item) => [item.attId, item.mediaOrdinal])).toEqual([
      ['removed', 2],
      ['remaining', 1],
    ]);
  });

  it('uses generated media names while ordinary files keep their file name', () => {
    expect(
      attachmentReferenceName(
        { kind: 'image', name: 'IMG_001.png', mediaOrdinal: 3 },
        { image: 'Image', video: 'Video' },
      ),
    ).toBe('Image 3');
    expect(
      attachmentReferenceName(
        { kind: 'image', name: 'IMG_001.png', mediaOrdinal: 3 },
        { image: '图片', video: '视频' },
      ),
    ).toBe('图片 3');
    expect(
      attachmentReferenceName(
        { kind: 'file', name: 'spec.pdf' },
        { image: 'Image', video: 'Video' },
      ),
    ).toBe('spec.pdf');
  });
});

describe('isDraftEntryRecoverable', () => {
  it('recovers foreign-session uploads only into the new-session scope', () => {
    const foreign: AttachmentEntry = { ...entry('a', 'image'), fileId: 'file-1', sessionId: 'session-1' };

    expect(isDraftEntryRecoverable(foreign, undefined)).toBe(true);
    expect(isDraftEntryRecoverable(foreign, 'session-1')).toBe(true);
    expect(isDraftEntryRecoverable(foreign, 'session-2')).toBe(false);
  });

  it('still drops unfinished, failed, or uploadless entries', () => {
    expect(isDraftEntryRecoverable({ ...entry('a', 'image'), fileId: 'file-1', uploading: true }, undefined)).toBe(false);
    expect(isDraftEntryRecoverable({ ...entry('a', 'image'), fileId: 'file-1', error: 'upload-failed' }, undefined)).toBe(false);
    expect(isDraftEntryRecoverable(entry('a', 'image'), undefined)).toBe(false);
  });

  it('keeps folders recoverable regardless of upload state', () => {
    expect(isDraftEntryRecoverable(entry('f', 'folder'), undefined)).toBe(true);
    expect(isDraftEntryRecoverable(entry('f', 'folder'), 'session-2')).toBe(true);
  });
});
