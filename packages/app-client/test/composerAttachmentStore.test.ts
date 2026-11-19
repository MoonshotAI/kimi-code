import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { ComposerAttachmentStore } from '../src/lib/composerAttachmentStore';

function entry(attId: string, overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
  return {
    attId,
    key: `blob:${attId}`,
    kind: 'image',
    name: `${attId}.png`,
    refCount: 0,
    uploading: true,
    ...overrides,
  };
}

describe('ComposerAttachmentStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scopes assets and listeners by composer session', () => {
    const store = new ComposerAttachmentStore();
    const seen: string[][] = [];
    const stop = store.subscribe('a', (entries) => seen.push(entries.map((item) => item.attId)));
    store.upsert('a', entry('one'));
    store.upsert('b', entry('two'));
    expect(store.entries('a').map((item) => item.attId)).toEqual(['one']);
    expect(store.entries('b').map((item) => item.attId)).toEqual(['two']);
    expect(seen).toEqual([[], ['one']]);
    stop();
  });

  it('keeps a source while inactive and releases it after upload settles', () => {
    const store = new ComposerAttachmentStore();
    const source = new Blob(['image'], { type: 'image/png' });
    store.upsert('a', entry('one'), source);
    const upload = store.beginUpload('a', 'one');
    expect(upload).not.toBeNull();
    store.patch('a', 'one', { uploading: false, fileId: 'file-one' });
    store.settleUpload('a', 'one', upload!.generation);
    expect(store.source('a', 'one')).toBeUndefined();
  });

  it('invalidates an upload generation when aborted', () => {
    const store = new ComposerAttachmentStore();
    store.upsert('a', entry('one'), new Blob(['image']));
    const upload = store.beginUpload('a', 'one')!;
    expect(store.uploadIsCurrent('a', 'one', upload.generation)).toBe(true);
    store.abortUpload('a', 'one');
    expect(upload.signal.aborted).toBe(true);
    expect(store.uploadIsCurrent('a', 'one', upload.generation)).toBe(false);
  });

  it('revokes object URLs only when resources are replaced or disposed', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const store = new ComposerAttachmentStore();
    store.upsert('a', entry('one', { previewUrl: 'blob:first' }));
    store.patch('a', 'one', { previewUrl: 'blob:second' });
    expect(revoke).toHaveBeenCalledWith('blob:first');
    store.clear('a');
    expect(revoke).toHaveBeenCalledWith('blob:second');
  });

  it('keeps a live preview when a serializable draft snapshot refreshes the same asset', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const store = new ComposerAttachmentStore();
    store.upsert('a', entry('one', { previewUrl: 'blob:live' }));

    store.load('a', [entry('one', { uploading: false, fileId: 'file-one' })]);

    expect(store.entry('a', 'one')?.previewUrl).toBe('blob:live');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('assigns one stable media ordinal sequence without reusing inactive entries', () => {
    const store = new ComposerAttachmentStore();
    store.upsert('a', entry('one'));
    store.upsert('a', entry('two'));
    store.upsert('a', entry('clip', { kind: 'video', name: 'clip.mov' }));

    expect(store.entry('a', 'one')?.mediaOrdinal).toBe(1);
    expect(store.entry('a', 'two')?.mediaOrdinal).toBe(2);
    expect(store.entry('a', 'clip')?.mediaOrdinal).toBe(3);

    store.upsert('a', entry('three'));
    expect(store.entry('a', 'three')?.mediaOrdinal).toBe(4);
  });

  it('normalizes legacy draft entries while preserving an existing ordinal', () => {
    const store = new ComposerAttachmentStore();
    store.load('a', [
      entry('legacy'),
      entry('named', { mediaOrdinal: 4 }),
    ]);

    expect(store.entry('a', 'legacy')?.mediaOrdinal).toBe(5);
    expect(store.entry('a', 'named')?.mediaOrdinal).toBe(4);
  });

  it('releases reconstructable inactive resources without dropping undo metadata', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const store = new ComposerAttachmentStore();
    const source = new Blob(['image']);
    store.upsert('a', entry('ready', {
      kind: 'video',
      uploading: false,
      fileId: 'file-ready',
      previewUrl: 'blob:ready',
      thumbnailUrl: 'data:image/jpeg;base64,dGh1bWI=',
    }), source);

    store.releaseInactiveResources('a', new Set());

    expect(store.entry('a', 'ready')).toMatchObject({
      attId: 'ready',
      fileId: 'file-ready',
      previewUrl: undefined,
      thumbnailUrl: 'data:image/jpeg;base64,dGh1bWI=',
    });
    expect(store.source('a', 'ready')).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith('blob:ready');
  });

  it('bounds inactive thumbnail-only entries without a reconstructable file', () => {
    const store = new ComposerAttachmentStore();
    store.upsert('a', entry('pending', {
      kind: 'video',
      thumbnailUrl: 'data:image/jpeg;base64,dGh1bWI=',
    }));

    store.releaseInactiveResources('a', new Set(), 0, 0);

    expect(store.entry('a', 'pending')).toMatchObject({
      thumbnailUrl: undefined,
      uploading: false,
      error: 'upload-interrupted',
    });
  });

  it('bounds inactive source blobs while preserving interrupted entry metadata', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const store = new ComposerAttachmentStore();
    for (let i = 0; i < 3; i++) {
      store.upsert(
        'a',
        entry(`pending-${i}`, { previewUrl: `blob:pending-${i}`, size: 5 }),
        new Blob(['12345']),
      );
    }

    store.releaseInactiveResources('a', new Set(), 1, 5);

    expect(store.entries('a')).toHaveLength(3);
    expect(store.entry('a', 'pending-0')).toMatchObject({
      uploading: false,
      error: 'upload-interrupted',
      previewUrl: undefined,
    });
    expect(store.source('a', 'pending-0')).toBeUndefined();
    expect(store.source('a', 'pending-1')).toBeUndefined();
    expect(store.source('a', 'pending-2')).toBeInstanceOf(Blob);
    expect(revoke).toHaveBeenCalledWith('blob:pending-0');
    expect(revoke).toHaveBeenCalledWith('blob:pending-1');
  });
});

describe('draft restoration', () => {
  it('preserves a live new-session upload when rebinding its draft', () => {
    const store = new ComposerAttachmentStore();
    const scope = '__new__';
    const source = new Blob(['pending video'], { type: 'video/mp4' });
    store.upsert(scope, entry('clip', { kind: 'video', uploadProgress: 0.4 }), source);
    const upload = store.beginUpload(scope, 'clip')!;
    const readDraft = vi.fn(() => [entry('clip', {
      kind: 'video', uploading: false, error: 'upload-interrupted',
    })]);

    store.restore('existing', () => []);
    store.restore(scope, readDraft);

    expect(readDraft).not.toHaveBeenCalled();
    expect(store.entry(scope, 'clip')).toMatchObject({ uploading: true, uploadProgress: 0.4 });
    expect(store.entry(scope, 'clip')?.error).toBeUndefined();
    expect(store.source(scope, 'clip')).toBe(source);
    expect(upload.signal.aborted).toBe(false);
    expect(store.uploadIsCurrent(scope, 'clip', upload.generation)).toBe(true);
    store.patch(scope, 'clip', { uploading: false, fileId: 'uploaded' });
    store.settleUpload(scope, 'clip', upload.generation);
    expect(store.entry(scope, 'clip')?.fileId).toBe('uploaded');
  });

  it('loads a persisted draft when no live resources exist', () => {
    const store = new ComposerAttachmentStore();
    const interrupted = entry('clip', { uploading: false, error: 'upload-interrupted' });
    store.restore('__new__', () => [interrupted]);
    expect(store.entry('__new__', 'clip')).toMatchObject(interrupted);
  });
});


it('retains the source of a cancelled cross-session read for reactivation only while identity matches', () => {
  const store = new ComposerAttachmentStore();
  const copied = entry('copy', { key: 'blob:session-a:video' });
  store.upsert('b', copied);
  store.setRemoteSource('b', 'copy', { sessionId: 'session-a', fileId: 'video' });
  const read = store.beginUpload('b', 'copy')!;
  store.abortUpload('b', 'copy');
  expect(read.signal.aborted).toBe(true);
  expect(store.uploadIsCurrent('b', 'copy', read.generation)).toBe(false);
  store.sync('b', store.entries('b'));
  expect(store.remoteSource('b', 'copy')).toEqual({ sessionId: 'session-a', fileId: 'video' });
  store.upsert('b', entry('copy', { key: 'another-video' }));
  expect(store.remoteSource('b', 'copy')).toBeUndefined();
});
