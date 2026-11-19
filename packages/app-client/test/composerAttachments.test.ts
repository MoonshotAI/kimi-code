import { describe, expect, it } from 'vitest';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';
import {
  applyEntryPatch,
  attachmentKind,
  buildSubmitPayload,
  editRefillAttachments,
  insertsAttachmentReference,
  mediaReorderTargetIndex,
  mergePatchedDraftEntries,
  pillSubmitBlockers,
  planFileAttachment,
  planFolderAttachment,
  retainAttachmentsForDeparture,
  seedEntriesForTurnAttachments,
  snapshotAttachmentEntries,
  unreferencedSeedFiles,
  unreferencedSeedMedia,
} from '../src/lib/composerAttachments';

describe('attachmentKind', () => {
  it.each([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'IMAGE/PNG; charset=binary',
  ])('classifies model-supported image MIME %s as media', (mime) => {
    expect(attachmentKind(mime)).toBe('image');
  });

  it.each([
    'image/svg+xml',
    'image/avif',
    'image/heic',
    'image/heif',
    'image/bmp',
    'image/tiff',
    'image/x-icon',
  ])('classifies unsupported image MIME %s as a file', (mime) => {
    expect(attachmentKind(mime)).toBe('file');
  });

  it('keeps video and ordinary file classification unchanged', () => {
    expect(attachmentKind('video/mp4')).toBe('video');
    expect(attachmentKind('application/pdf')).toBe('file');
  });

  it('routes unsupported image MIME through the ordinary file reference path', () => {
    const kind = attachmentKind('image/svg+xml');
    expect(kind).toBe('file');
    expect(insertsAttachmentReference(kind, 'drop')).toBe(true);
  });
});

describe('insertsAttachmentReference', () => {
  it('keeps every media source inventory-only by default', () => {
    expect(insertsAttachmentReference('image', 'drop')).toBe(false);
    expect(insertsAttachmentReference('video', 'picker')).toBe(false);
    expect(insertsAttachmentReference('image', 'paste-composer')).toBe(false);
    expect(insertsAttachmentReference('image', 'paste-editor')).toBe(false);
    expect(insertsAttachmentReference('video', 'paste-editor')).toBe(false);
  });

  it('enables references only for supported images pasted into the editor', () => {
    expect(insertsAttachmentReference('image', 'paste-editor', true)).toBe(true);
    for (const source of ['drop', 'picker', 'paste-composer', 'screenshot'] as const) {
      expect(insertsAttachmentReference('image', source, true)).toBe(false);
    }
    expect(insertsAttachmentReference('video', 'paste-editor', true)).toBe(false);
  });

  it('preserves ordinary file references, including unsupported image types', () => {
    expect(insertsAttachmentReference('file', 'drop')).toBe(true);
    expect(insertsAttachmentReference('file', 'picker')).toBe(true);
    expect(insertsAttachmentReference('file', 'paste-editor')).toBe(true);
    expect(insertsAttachmentReference(attachmentKind('image/svg+xml'), 'paste-editor', true)).toBe(true);
  });
});

describe('mediaReorderTargetIndex', () => {
  it('maps a media-only destination back into the mixed inventory order', () => {
    const ordered = ['file-a', 'image-a', 'file-b', 'video-b'];
    const media = ['image-a', 'video-b'];
    expect(mediaReorderTargetIndex(ordered, media, 'image-a', 1)).toBe(3);
    expect(mediaReorderTargetIndex(ordered, media, 'video-b', 0)).toBe(1);
  });

  it('returns null for no-ops and stale ids', () => {
    expect(mediaReorderTargetIndex(['image-a'], ['image-a'], 'image-a', 0)).toBeNull();
    expect(mediaReorderTargetIndex([], [], 'missing', 0)).toBeNull();
  });
});

function entry(overrides?: Partial<AttachmentEntry>): AttachmentEntry {
  return {
    attId: 'existing1',
    key: 'file:///docs/a.pdf',
    kind: 'file',
    name: 'a.pdf',
    size: 10,
    path: '/docs/a.pdf',
    refCount: 1,
    uploading: false,
    fileId: 'f_ready',
    ...overrides,
  };
}

describe('snapshotAttachmentEntries', () => {
  it('keeps attachment identity while dropping transient preview state', () => {
    const source = entry({
      attId: 'image-1',
      key: 'blob:image-1',
      kind: 'image',
      previewUrl: 'blob:revoked-after-dispatch',
      uploadProgress: 0.75,
    });

    expect(snapshotAttachmentEntries([source])).toEqual([{
      ...source,
      previewUrl: undefined,
      uploadProgress: undefined,
    }]);
    expect(source.previewUrl).toBe('blob:revoked-after-dispatch');
  });
});

describe('retainAttachmentsForDeparture', () => {
  it('keeps rail media and referenced files in their active order', () => {
    const entries = [
      entry({ attId: 'unused-file' }),
      entry({ attId: 'rail-image', kind: 'image' }),
      entry({ attId: 'linked-file' }),
      entry({ attId: 'linked-video', kind: 'video' }),
    ];

    expect(
      retainAttachmentsForDeparture(entries, ['linked-file', 'linked-video']).map(
        (candidate) => candidate.attId,
      ),
    ).toEqual(['rail-image', 'linked-file', 'linked-video']);
  });
});

describe('planFileAttachment', () => {
  it('mints a fresh uploading entry keyed by the normalized file:// path', () => {
    const plan = planFileAttachment([], { name: 'a.pdf', size: 10, path: '/docs//a.pdf', mediaType: 'application/pdf', lastModified: 111 });
    expect(plan.entry).not.toBeNull();
    expect(plan.startUpload).toBe(true);
    expect(plan.entry).toMatchObject({
      attId: plan.attId,
      key: 'file:///docs/a.pdf',
      kind: 'file',
      name: 'a.pdf',
      size: 10,
      mediaType: 'application/pdf',
      lastModified: 111,
      path: '/docs/a.pdf',
      uploading: true,
    });
  });

  it('keys pathless bytes (clipboard paste) on the fresh attId — never deduped', () => {
    const first = planFileAttachment([], { name: 'paste-1.png', size: 5, path: null });
    expect(first.entry?.key).toBe(`blob:${first.attId}`);
    const second = planFileAttachment([first.entry!], { name: 'paste-1.png', size: 5, path: null });
    expect(second.attId).not.toBe(first.attId);
    expect(second.entry).not.toBeNull();
  });

  it('re-dropping the same pathless file after a failed upload revives THAT entry (the tooltip’s retry)', () => {
    const failed = entry({
      attId: 'blob0001',
      key: 'blob:blob0001',
      path: undefined,
      name: 'paste-1.png',
      size: 5,
      error: 'upload-failed',
      fileId: undefined,
    });
    const plan = planFileAttachment([failed], { name: 'paste-1.png', size: 5, path: null });
    expect(plan.attId).toBe('blob0001');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(true);
  });

  it('mints a fresh entry for pathless bytes that differ in name or size — and for a non-errored match', () => {
    const failed = entry({
      attId: 'blob0001',
      key: 'blob:blob0001',
      path: undefined,
      name: 'paste-1.png',
      size: 5,
      error: 'upload-failed',
      fileId: undefined,
    });
    expect(planFileAttachment([failed], { name: 'other.png', size: 5, path: null }).entry).not.toBeNull();
    expect(planFileAttachment([failed], { name: 'paste-1.png', size: 6, path: null }).entry).not.toBeNull();
    const ready = entry({ attId: 'blob0002', key: 'blob:blob0002', path: undefined, name: 'paste-1.png', size: 5 });
    expect(planFileAttachment([ready], { name: 'paste-1.png', size: 5, path: null }).entry).not.toBeNull();
    const uploading = entry({ attId: 'blob0003', key: 'blob:blob0003', path: undefined, name: 'paste-1.png', size: 5, uploading: true, fileId: undefined });
    expect(planFileAttachment([uploading], { name: 'paste-1.png', size: 5, path: null }).entry).not.toBeNull();
  });

  it('mints a fresh entry when TWO errored pathless entries share name+size (an ambiguous retry never swaps bytes)', () => {
    const first = entry({ attId: 'blob0001', key: 'blob:blob0001', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined });
    const second = entry({ attId: 'blob0002', key: 'blob:blob0002', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined });
    const plan = planFileAttachment([first, second], { name: 'paste-1.png', size: 5, path: null });
    expect(plan.entry).not.toBeNull();
    expect(plan.attId).not.toBe('blob0001');
    expect(plan.attId).not.toBe('blob0002');
    expect(plan.startUpload).toBe(true);
  });

  it('breaks an ambiguous pathless retry by lastModified when exactly one candidate matches', () => {
    const first = entry({ attId: 'blob0001', key: 'blob:blob0001', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined, lastModified: 111 });
    const second = entry({ attId: 'blob0002', key: 'blob:blob0002', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined, lastModified: 222 });
    const plan = planFileAttachment([first, second], { name: 'paste-1.png', size: 5, path: null, lastModified: 222 });
    expect(plan.attId).toBe('blob0002');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(true);
    expect(planFileAttachment([first, second], { name: 'paste-1.png', size: 5, path: null, lastModified: 333 }).entry).not.toBeNull();
  });

  it('scopes the plan by kind: an image retry matches an errored IMAGE entry, never a file one', () => {
    const failedImage = entry({ attId: 'blob0001', key: 'blob:blob0001', kind: 'image', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined });
    const failedFile = entry({ attId: 'blob0002', key: 'blob:blob0002', kind: 'file', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined });
    const plan = planFileAttachment([failedImage, failedFile], { name: 'paste-1.png', size: 5, path: null, kind: 'image' });
    expect(plan.attId).toBe('blob0001');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(true);
    const fresh = planFileAttachment([], { name: 'shot.png', size: 9, path: null, kind: 'image' });
    expect(fresh.entry).toMatchObject({ kind: 'image', name: 'shot.png', mediaOrdinal: 1, uploading: true });
    const next = planFileAttachment([fresh.entry!], { name: 'second.png', size: 10, path: null, kind: 'image' });
    expect(next.entry).toMatchObject({ mediaOrdinal: 2 });
    expect(fresh.startUpload).toBe(true);
  });

  it('a size-LESS clipboard entry (copied from an old message) still matches the retry by name alone — unambiguously', () => {
    const legacy = entry({ attId: 'blob0001', key: 'blob:blob0001', kind: 'image', path: undefined, name: 'shot.png', size: undefined, error: 'upload-interrupted', fileId: undefined, sessionId: 's_1' });
    const plan = planFileAttachment([legacy], { name: 'shot.png', size: 5, path: null, kind: 'image' });
    expect(plan.attId).toBe('blob0001');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(true);
    const twin = entry({ attId: 'blob0002', key: 'blob:blob0002', kind: 'image', path: undefined, name: 'shot.png', size: undefined, error: 'upload-interrupted', fileId: undefined, sessionId: 's_2' });
    const forced = planFileAttachment([legacy, twin], { name: 'shot.png', size: 5, path: null, kind: 'image' });
    expect(forced.entry).not.toBeNull();
    expect(forced.attId).not.toBe('blob0001');
    expect(forced.attId).not.toBe('blob0002');
    const sameNameFile = entry({ attId: 'blob0003', key: 'blob:blob0003', kind: 'file', path: undefined, name: 'shot.png', size: undefined, error: 'upload-interrupted' });
    expect(planFileAttachment([legacy, sameNameFile], { name: 'shot.png', size: 5, path: null, kind: 'image' }).attId).toBe('blob0001');
  });

  it('reuses the existing entry on a file:// key hit (one upload, many pills)', () => {
    const existing = entry();
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf' });
    expect(plan.attId).toBe('existing1');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(false);
  });

  it('does NOT cross kinds on the same path key: an image add mismatched against a stale file entry mints its own', () => {
    const staleFile = entry({ attId: 'aa000001', key: 'file:///docs/shot.png', kind: 'file', name: 'shot.png', path: '/docs/shot.png', size: 9 });
    const plan = planFileAttachment([staleFile], { name: 'shot.png', size: 9, path: '/docs/shot.png', kind: 'image' });
    expect(plan.entry).not.toBeNull();
    expect(plan.attId).not.toBe('aa000001');
    expect(plan.entry).toMatchObject({ kind: 'image', uploading: true });
    expect(plan.startUpload).toBe(true);
    const same = planFileAttachment([staleFile], { name: 'shot.png', size: 9, path: '/docs/shot.png' });
    expect(same.attId).toBe('aa000001');
    expect(same.entry).toBeNull();
  });

  it('does not restart an upload that is still in flight on key reuse', () => {
    const existing = entry({ uploading: true, fileId: undefined });
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf' });
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(false);
  });

  it('re-dropping a file whose upload failed restarts the upload on the same entry', () => {
    const existing = entry({ error: 'upload-failed', fileId: undefined });
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf' });
    expect(plan.attId).toBe('existing1');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(true);
  });

  it('restarts the upload for a reused entry that never got a fileId (interrupted)', () => {
    const existing = entry({ error: 'upload-interrupted', fileId: undefined });
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf' });
    expect(plan.startUpload).toBe(true);
  });

  it('reuses a ready entry while the on-disk version still matches (size + lastModified)', () => {
    const existing = entry({ size: 10, lastModified: 111 });
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf', lastModified: 111 });
    expect(plan.attId).toBe('existing1');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(false);
  });

  it('re-uploads on the same entry when the file on disk CHANGED (size or lastModified mismatch)', () => {
    const bySize = entry({ size: 10, lastModified: 111 });
    expect(planFileAttachment([bySize], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 111 })).toMatchObject({
      startUpload: true,
      resetRemoteIdentity: true,
    });
    const byMtime = entry({ size: 10, lastModified: 111 });
    expect(planFileAttachment([byMtime], { name: 'a.pdf', size: 10, path: '/docs/a.pdf', lastModified: 222 })).toMatchObject({
      startUpload: true,
      resetRemoteIdentity: true,
    });
    const inFlight = entry({ attId: 'inflt001', key: 'file:///docs/a.pdf', size: 10, lastModified: 111, uploading: true, fileId: undefined });
    const midUpload = planFileAttachment([inFlight], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 222 });
    expect(midUpload.entry).not.toBeNull();
    expect(midUpload.attId).not.toBe('inflt001');
  });

  it('cannot prove a change without recorded markers — a pre-versioning entry keeps the old reuse behavior', () => {
    const legacy = entry({ size: 10, lastModified: undefined });
    expect(planFileAttachment([legacy], { name: 'a.pdf', size: 10, path: '/docs/a.pdf', lastModified: 222 }).startUpload).toBe(false);
    expect(planFileAttachment([legacy], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 222 }).startUpload).toBe(true);
  });

  it('mints an independent entry when the file changed MID-UPLOAD (each pill keeps its own version)', () => {
    const inFlight = entry({ attId: 'upload01', key: 'file:///docs/a.pdf', path: '/docs/a.pdf', size: 10, lastModified: 111, uploading: true, fileId: undefined });
    const plan = planFileAttachment([inFlight], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 222 });
    expect(plan.attId).not.toBe('upload01');
    expect(plan.startUpload).toBe(true);
    expect(plan.entry).toMatchObject({
      key: 'file:///docs/a.pdf',
      kind: 'file',
      size: 12,
      lastModified: 222,
      uploading: true,
    });
  });

  it('prefers the newest same-key entry on later re-drops (version compares against the latest upload)', () => {
    const first = entry({ attId: 'upload01', key: 'file:///docs/a.pdf', path: '/docs/a.pdf', size: 10, lastModified: 111, uploading: true, fileId: undefined });
    const second = entry({ attId: 'upload02', key: 'file:///docs/a.pdf', path: '/docs/a.pdf', size: 12, lastModified: 222, fileId: 'f_v2' });
    const plan = planFileAttachment([first, second], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 222 });
    expect(plan.attId).toBe('upload02');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(false);
  });
});

describe('planFolderAttachment', () => {
  it('names the pill from the path basename with a trailing slash, never uploading', () => {
    const plan = planFolderAttachment([], '/work/my dir/');
    expect(plan.name).toBe('my dir/');
    expect(plan.entry).toMatchObject({
      key: 'file:///work/my dir/',
      kind: 'folder',
      path: '/work/my dir',
      uploading: false,
    });
  });

  it('reuses the existing folder entry on a key hit', () => {
    const existing = entry({ attId: 'fold9999', key: 'file:///work/', kind: 'folder', name: 'work/', path: '/work', fileId: undefined });
    const plan = planFolderAttachment([existing], '/work');
    expect(plan.attId).toBe('fold9999');
    expect(plan.entry).toBeNull();
  });

  it('names root folders after the root itself (no basename to take)', () => {
    const posix = planFolderAttachment([], '/');
    expect(posix.name).toBe('/');
    expect(posix.entry).toMatchObject({ name: '/', path: '/', key: 'file:////', kind: 'folder' });
    const drive = planFolderAttachment([], 'C:\\');
    expect(drive.name).toBe('C:/');
    expect(drive.entry).toMatchObject({ name: 'C:/', path: 'C:/', key: 'file://C://', kind: 'folder' });
  });
});

describe('buildSubmitPayload', () => {
  const ready = entry({ attId: 'aa', key: 'file:///a', path: '/a', name: 'a.txt', fileId: 'f_a', mediaType: 'text/plain' });
  const ready2 = entry({ attId: 'bb', key: 'file:///b', path: '/b', name: 'b.txt', fileId: 'f_b' });
  const readyImg = entry({ attId: 'im', key: 'blob:im', kind: 'image', path: undefined, name: 'shot.png', fileId: 'f_img', mediaType: 'image/png', mediaOrdinal: 1 });
  const readyVid = entry({ attId: 'vi', key: 'blob:vi', kind: 'video', path: undefined, name: 'demo.mp4', fileId: 'f_vid', sessionId: 's_1', mediaOrdinal: 2 });

  it('emits ready file entries in inventory order, with the family index lists mirroring the payload', () => {
    const { promptAttachments, fileAttIds, mediaAttIds } = buildSubmitPayload(['bb', 'aa'], [ready, ready2]);
    expect(fileAttIds).toEqual(['bb', 'aa']);
    expect(mediaAttIds).toEqual([]);
    expect(promptAttachments).toEqual([
      { clientId: 'bb', fileId: 'f_b', kind: 'file', sessionId: undefined, name: 'b.txt', mediaType: undefined, size: 10 },
      { clientId: 'aa', fileId: 'f_a', kind: 'file', sessionId: undefined, name: 'a.txt', mediaType: 'text/plain', size: 10 },
    ]);
  });

  it('emits referenced and unreferenced media in inventory order, splitting the families per kind', () => {
    const { promptAttachments, fileAttIds, mediaAttIds } = buildSubmitPayload(
      ['aa', 'im', 'bb', 'vi'],
      [ready, ready2, readyImg, readyVid],
    );
    expect(fileAttIds).toEqual(['aa', 'bb']);
    expect(mediaAttIds).toEqual(['im', 'vi']);
    expect(promptAttachments.map((att) => att.fileId)).toEqual(['f_a', 'f_img', 'f_b', 'f_vid']);
    expect(promptAttachments[1]).toMatchObject({ kind: 'image', mediaType: 'image/png', mediaOrdinal: 1 });
    expect(promptAttachments[3]).toMatchObject({ kind: 'video', sessionId: 's_1', mediaOrdinal: 2 });
  });

  it('skips folders, uploading, errored, and dead pills (their links stay raw)', () => {
    const folder = entry({ attId: 'fo', key: 'file:///f/', kind: 'folder', name: 'f/', fileId: undefined });
    const uploading = entry({ attId: 'up', key: 'file:///u', uploading: true, fileId: undefined });
    const errored = entry({ attId: 'er', key: 'file:///e', error: 'upload-failed', fileId: undefined });
    const { promptAttachments, fileAttIds } = buildSubmitPayload(
      ['fo', 'up', 'er', 'ghost', 'aa'],
      [ready, folder, uploading, errored],
    );
    expect(fileAttIds).toEqual(['aa']);
    expect(promptAttachments).toHaveLength(1);
    expect(promptAttachments[0]!.fileId).toBe('f_a');
  });

  it('returns an empty payload when the inventory is empty', () => {
    expect(buildSubmitPayload([], [ready])).toEqual({ promptAttachments: [], fileAttIds: [], mediaAttIds: [] });
  });

  it('drops a session-media entry that belongs to ANOTHER session (the daemon would reject the mismatched wire source)', () => {
    const same = buildSubmitPayload(['vi'], [readyVid], { sessionId: 's_1' });
    expect(same.mediaAttIds).toEqual(['vi']);
    expect(same.promptAttachments).toHaveLength(1);
    const cross = buildSubmitPayload(['vi'], [readyVid], { sessionId: 's_2' });
    expect(cross.mediaAttIds).toEqual([]);
    expect(cross.promptAttachments).toHaveLength(0);
    const empty = buildSubmitPayload(['vi'], [readyVid], { sessionId: undefined });
    expect(empty.promptAttachments).toHaveLength(0);
    const legacy = buildSubmitPayload(['vi'], [readyVid]);
    expect(legacy.promptAttachments).toHaveLength(1);
  });
});

describe('seedEntriesForTurnAttachments', () => {
  it('keys each family to its own 1-based ordinal, carrying fileId and sessionId — and the dedup key is the byte source, never the ordinal', () => {
    const atts: TurnAttachment[] = [
      { kind: 'image', url: 'https://x/img', fileId: 'f_img', name: 'shot.png', sessionId: 's_1' },
      { kind: 'file', url: 'https://x/a', fileId: 'f_a', name: 'a.pdf', size: 10, mediaType: 'application/pdf' },
      { kind: 'video', url: 'https://x/v', fileId: 'f_v', name: 'clip.mp4' },
      { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf' },
    ];
    const entries = seedEntriesForTurnAttachments(atts);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ attId: 'm1', key: 'blob:s_1:f_img', kind: 'image', fileId: 'f_img', sessionId: 's_1', mediaOrdinal: 1 });
    expect(entries[1]).toMatchObject({
      attId: '1',
      key: 'blob:f_a',
      kind: 'file',
      name: 'a.pdf',
      size: 10,
      mediaType: 'application/pdf',
      uploading: false,
      fileId: 'f_a',
    });
    expect(entries[2]).toMatchObject({ attId: 'm2', key: 'blob:f_v', kind: 'video', fileId: 'f_v', mediaOrdinal: 2 });
    expect(entries[3]).toMatchObject({ attId: '2', key: 'blob:f_b', fileId: 'f_b' });
  });

  it('retains unbacked media placeholders while skipping unresendable files', () => {
    const entries = seedEntriesForTurnAttachments([
      { kind: 'file', url: '', name: 'a.pdf' },
      { kind: 'image', url: '', name: 'shot.png' },
      { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf' },
      { kind: 'image', url: 'https://x/i2', fileId: 'f_i2', name: 'shot2.png' },
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      attId: 'm1',
      mediaOrdinal: 1,
      uploading: false,
      error: 'upload-interrupted',
    });
    expect(entries[1]).toMatchObject({ attId: '2', fileId: 'f_b' });
    expect(entries[2]).toMatchObject({ attId: 'm2', fileId: 'f_i2' });
  });

  it('keeps URL-only media in its original position among backed media', () => {
    const entries = seedEntriesForTurnAttachments([
      { kind: 'image', url: 'https://x/i1', fileId: 'f_i1', name: 'one.png' },
      { kind: 'video', url: 'https://x/v2', name: 'two.mp4' },
      { kind: 'image', url: 'https://x/i3', fileId: 'f_i3', name: 'three.png' },
    ]);

    expect(entries.map((entry) => [entry.attId, entry.fileId, entry.uploading])).toEqual([
      ['m1', 'f_i1', false],
      ['m2', undefined, true],
      ['m3', 'f_i3', false],
    ]);
    const firstSourceKey = seedEntriesForTurnAttachments([
      { kind: 'video', url: 'https://x/v2', name: 'two.mp4' },
    ])[0]?.key;
    const otherSourceKey = seedEntriesForTurnAttachments([
      { kind: 'video', url: 'https://x/other', name: 'two.mp4' },
    ])[0]?.key;
    expect(firstSourceKey).not.toBe(otherSourceKey);
  });
});

describe('unreferencedSeedMedia', () => {
  const media: TurnAttachment[] = [
    { kind: 'file', url: 'https://x/a', fileId: 'f_a', name: 'a.pdf' },
    { kind: 'image', url: 'https://x/i1', fileId: 'f_i1', name: 'one.png' },
    { kind: 'video', url: 'https://x/v', fileId: 'f_v', name: 'clip.mp4' },
    { kind: 'image', url: 'data:image/png;base64,AA', name: 'no-id.png' },
  ];

  it('returns every media part when the revived doc references nothing (chip-era message, fileId-less included)', () => {
    expect(unreferencedSeedMedia(media, new Set())).toEqual([
      { att: media[1], ordinal: 1 },
      { att: media[2], ordinal: 2 },
      { att: media[3], ordinal: 3 },
    ]);
  });

  it('skips the m-ordinals the doc references, counting every media part toward the ordinal', () => {
    expect(unreferencedSeedMedia(media, new Set(['m1']))).toEqual([
      { att: media[2], ordinal: 2 },
      { att: media[3], ordinal: 3 },
    ]);
    expect(unreferencedSeedMedia(media, new Set(['m1', 'm2']))).toEqual([{ att: media[3], ordinal: 3 }]);
    expect(unreferencedSeedMedia(media, new Set(['m3']))).toEqual([
      { att: media[1], ordinal: 1 },
      { att: media[2], ordinal: 2 },
    ]);
    expect(unreferencedSeedMedia(media, new Set(['m1', 'm2', 'm3']))).toEqual([]);
  });
});

describe('unreferencedSeedFiles', () => {
  const files: TurnAttachment[] = [
    { kind: 'image', url: 'https://x/img', fileId: 'f_img', name: 'shot.png' },
    { kind: 'file', url: 'https://x/a', fileId: 'f_a', name: 'a.pdf', size: 10 },
    { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf' },
    { kind: 'file', url: '', name: 'no-id.pdf' },
  ];

  it('returns every file attachment with a fileId when the revived doc references nothing (chip-era message)', () => {
    const unreferenced = unreferencedSeedFiles(files, new Set());
    expect(unreferenced).toEqual([
      { att: files[1], ordinal: 1 },
      { att: files[2], ordinal: 2 },
    ]);
  });

  it('skips the ordinals the doc references (link-era message), keeping the rest', () => {
    expect(unreferencedSeedFiles(files, new Set(['1']))).toEqual([{ att: files[2], ordinal: 2 }]);
    expect(unreferencedSeedFiles(files, new Set(['1', '2']))).toEqual([]);
  });

  it('counts fileId-less files toward the ordinal (a base64 file occupies its index)', () => {
    const mixed: TurnAttachment[] = [
      { kind: 'file', url: '', name: 'raw.pdf' },
      { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf' },
    ];
    expect(unreferencedSeedFiles(mixed, new Set(['2']))).toEqual([]);
    expect(unreferencedSeedFiles(mixed, new Set(['1']))).toEqual([{ att: mixed[1], ordinal: 2 }]);
    expect(unreferencedSeedFiles(mixed, new Set())).toEqual([{ att: mixed[1], ordinal: 2 }]);
  });
});

describe('pillSubmitBlockers (the send gate’s pill verdict)', () => {
  it('is clear for ready entries', () => {
    expect(pillSubmitBlockers([entry()])).toEqual({ uploading: false, errored: false, missing: false });
    expect(pillSubmitBlockers([])).toEqual({ uploading: false, errored: false, missing: false });
  });

  it('flags an in-flight upload', () => {
    const uploading = entry({ uploading: true, fileId: undefined });
    expect(pillSubmitBlockers([entry(), uploading])).toEqual({ uploading: true, errored: false, missing: false });
  });

  it('flags an errored entry — a HARD block (the submit payload would silently drop it)', () => {
    const failed = entry({ error: 'upload-failed', fileId: undefined });
    const interrupted = entry({ error: 'upload-interrupted', fileId: undefined });
    expect(pillSubmitBlockers([entry(), failed])).toEqual({ uploading: false, errored: true, missing: false });
    expect(pillSubmitBlockers([interrupted])).toEqual({ uploading: false, errored: true, missing: false });
  });

  it('flags both when an upload is in flight next to a failed one', () => {
    const uploading = entry({ attId: 'up000001', uploading: true, fileId: undefined });
    const failed = entry({ error: 'upload-failed', fileId: undefined });
    expect(pillSubmitBlockers([uploading, failed])).toEqual({ uploading: true, errored: true, missing: false });
  });

  it('flags a doc attId with NO registry entry — the undo-resurrected dead pill', () => {
    const ready = entry({ attId: 'live0001' });
    expect(pillSubmitBlockers([ready], ['live0001', 'ghost001'])).toEqual({
      uploading: false,
      errored: false,
      missing: true,
    });
    const uploading = entry({ attId: 'up000001', uploading: true, fileId: undefined });
    expect(pillSubmitBlockers([uploading], ['up000001', 'ghost001'])).toEqual({
      uploading: true,
      errored: false,
      missing: true,
    });
  });

  it('stays clear when every doc attId has a registry entry', () => {
    const ready = entry({ attId: 'live0001' });
    expect(pillSubmitBlockers([ready], ['live0001'])).toEqual({ uploading: false, errored: false, missing: false });
    expect(pillSubmitBlockers([ready], [])).toEqual({ uploading: false, errored: false, missing: false });
  });

  it('never flags missing without the doc attIds (back-compat: the registry mirror alone can’t see dead pills)', () => {
    expect(pillSubmitBlockers([entry()]).missing).toBe(false);
  });

  it('flags a session-media entry from another session as errored when the composer binds a session id', () => {
    const foreign = entry({ kind: 'image', fileId: 'f_img', sessionId: 's_1' });
    expect(pillSubmitBlockers([foreign], undefined, { sessionId: 's_1' })).toEqual({ uploading: false, errored: false, missing: false });
    expect(pillSubmitBlockers([foreign], undefined, { sessionId: 's_2' })).toEqual({ uploading: false, errored: true, missing: false });
    expect(pillSubmitBlockers([foreign], undefined, { sessionId: undefined }).errored).toBe(true);
    expect(pillSubmitBlockers([foreign])).toEqual({ uploading: false, errored: false, missing: false });
  });
});

describe('editRefillAttachments (the edit&resend positional rebuild)', () => {
  const f1: TurnAttachment = { kind: 'file', url: 'https://x/a', fileId: 'f_a', name: 'a.pdf', size: 1 };
  const f2: TurnAttachment = { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf', size: 2 };
  const img: TurnAttachment = { kind: 'image', url: 'https://x/img', fileId: 'f_img', name: 'shot.png' };

  it('a pill-flow turn refills from inlineAttachments ALONE (the complete payload-order list — never concatenated)', () => {
    const refill = editRefillAttachments({ attachments: [img], inlineAttachments: [f1, img, f2] });
    expect(refill).toEqual([f1, img, f2]);
    expect(seedEntriesForTurnAttachments(refill).map((e) => [e.attId, e.fileId])).toEqual([
      ['1', 'f_a'],
      ['m1', 'f_img'],
      ['2', 'f_b'],
    ]);
  });

  it('falls back to the legacy (link-less) turn\'s attachments VERBATIM — the original content-part order (Codex round 8: a media-first shuffle flips a mixed message)', () => {
    expect(editRefillAttachments({ attachments: [f1, img, f2] })).toEqual([f1, img, f2]);
    expect(editRefillAttachments({})).toEqual([]);
  });
});

describe('applyEntryPatch (the history-browse snapshot updater)', () => {
  it('patches the matching entry and leaves others untouched', () => {
    const entries = [entry({ attId: 'a1', uploading: true }), entry({ attId: 'b2', uploading: true })];
    const next = applyEntryPatch(entries, 'b2', { fileId: 'f_done', uploading: false, error: undefined });
    expect(next[0]).toEqual(entries[0]);
    expect(next[1]).toMatchObject({ attId: 'b2', fileId: 'f_done', uploading: false });
    expect(next[1]!.error).toBeUndefined();
  });

  it('is a no-op for an unknown attId (a patch for an entry the snapshot never held)', () => {
    const entries = [entry({ attId: 'a1', uploading: true })];
    expect(applyEntryPatch(entries, 'zz', { uploading: false })).toEqual(entries);
  });
});

describe('mergePatchedDraftEntries (the offline completion write-back)', () => {
  it('patches an entry the persisted draft already holds', () => {
    const persisted = [entry({ attId: 'a1', uploading: true, fileId: undefined })];
    const storeEntry = entry({ attId: 'a1', uploading: false, fileId: 'f_done' });
    const next = mergePatchedDraftEntries(persisted, 'a1', { uploading: false, fileId: 'f_done' }, storeEntry);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ attId: 'a1', uploading: false, fileId: 'f_done' });
  });

  it('appends the full store entry when an in-flight upload completes after the scope lost its editor (never persisted)', () => {
    const storeEntry = entry({ attId: 'a1', uploading: false, fileId: 'f_done', mediaType: 'application/pdf' });
    const next = mergePatchedDraftEntries([], 'a1', { uploading: false, fileId: 'f_done' }, storeEntry);
    expect(next).toEqual([storeEntry]);
  });

  it('keeps sibling entries when appending the late-completed one', () => {
    const other = entry({ attId: 'b2' });
    const storeEntry = entry({ attId: 'a1', uploading: false, fileId: 'f_done' });
    const next = mergePatchedDraftEntries([other], 'a1', { uploading: false, fileId: 'f_done' }, storeEntry);
    expect(next).toEqual([other, storeEntry]);
  });

  it('appends nothing when the entry is gone from the store too (removed mid-upload)', () => {
    expect(mergePatchedDraftEntries([], 'a1', { uploading: false }, undefined)).toEqual([]);
  });
});
