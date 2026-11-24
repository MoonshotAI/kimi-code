import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useComposerDraft } from '../src/composables';
import { draftAttachmentsStorageKey, draftStorageKey } from '@moonshot-ai/app-core/lib';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function fileEntry(overrides?: Partial<AttachmentEntry>): AttachmentEntry {
  return {
    attId: 'a1b2c3d4',
    key: 'file:///docs/a.pdf',
    kind: 'file',
    name: 'a.pdf',
    size: 42,
    path: '/docs/a.pdf',
    refCount: 1,
    uploading: false,
    fileId: 'f_1',
    ...overrides,
  };
}

describe('useComposerDraft attachment sidecar', () => {
  let original: Storage | undefined;
  let draft: ReturnType<typeof useComposerDraft>;

  beforeEach(() => {
    draft = useComposerDraft({ sessionId: () => undefined });
    original = (globalThis as { localStorage?: Storage }).localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it('round-trips attachment entries for a session', () => {
    const entries = [
      fileEntry({ mediaType: 'application/pdf' }),
      fileEntry({ attId: 'f0ld3r00', key: 'file:///docs/', kind: 'folder', name: 'docs/', path: '/docs', fileId: undefined }),
      fileEntry({ attId: '1m4g3000', key: 'blob:1m4g3000', kind: 'image', name: 'shot.png', path: undefined, mediaType: 'image/png' }),
    ];
    draft.saveDraftAttachments('s1', entries);
    expect(draft.loadDraftAttachments('s1')).toEqual(entries);
  });

  it('returns an empty list when nothing is stored', () => {
    expect(draft.loadDraftAttachments('s1')).toEqual([]);
  });

  it('scopes entries per session', () => {
    draft.saveDraftAttachments('s1', [fileEntry()]);
    expect(draft.loadDraftAttachments('s2')).toEqual([]);
  });

  it('uses the __new__ key for an undefined session id', () => {
    draft.saveDraftAttachments(undefined, [fileEntry()]);
    expect(globalThis.localStorage.getItem(draftAttachmentsStorageKey(undefined))).not.toBeNull();
    expect(draft.loadDraftAttachments(undefined)).toHaveLength(1);
  });

  it('removes the key when saved an empty list', () => {
    draft.saveDraftAttachments('s1', [fileEntry()]);
    expect(globalThis.localStorage.getItem(draftAttachmentsStorageKey('s1'))).not.toBeNull();
    draft.saveDraftAttachments('s1', []);
    expect(globalThis.localStorage.getItem(draftAttachmentsStorageKey('s1'))).toBeNull();
  });

  it('drops malformed entries on load', () => {
    globalThis.localStorage.setItem(
      draftAttachmentsStorageKey('s1'),
      JSON.stringify([
        fileEntry(),
        { attId: 'x' },
        { attId: 'y', key: 'k', name: 'n', kind: 'widget' },
        'not-an-object',
      ]),
    );
    const loaded = draft.loadDraftAttachments('s1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.attId).toBe('a1b2c3d4');
  });

  it('returns an empty list for corrupted JSON', () => {
    globalThis.localStorage.setItem(draftAttachmentsStorageKey('s1'), '{not json');
    expect(draft.loadDraftAttachments('s1')).toEqual([]);
  });

  it('persists an attachment only once its upload completes', () => {
    draft.saveDraftAttachments('s1', [fileEntry({ uploading: true, fileId: undefined })]);
    expect(globalThis.localStorage.getItem(draftAttachmentsStorageKey('s1'))).toBeNull();
    draft.saveDraftAttachments('s1', [fileEntry({ uploading: false })]);
    expect(draft.loadDraftAttachments('s1')).toHaveLength(1);
  });

  it('never persists entries that cannot survive a reload', () => {
    draft.saveDraftAttachments('s1', [
      fileEntry({ uploading: true, fileId: undefined }),
      fileEntry({ attId: 'err00001', uploading: false, fileId: undefined, error: 'upload-failed' }),
      fileEntry({ attId: 'ok000001', uploading: false }),
    ]);
    expect(draft.loadDraftAttachments('s1').map((entry) => entry.attId)).toEqual(['ok000001']);
  });

  it('drops already-poisoned entries on load', () => {
    globalThis.localStorage.setItem(
      draftAttachmentsStorageKey('s1'),
      JSON.stringify([
        fileEntry({ uploading: true, fileId: undefined }),
        fileEntry({ attId: 'err00001', fileId: undefined, error: 'upload-failed' }),
        fileEntry({ attId: 'ok000001' }),
      ]),
    );
    expect(draft.loadDraftAttachments('s1').map((entry) => entry.attId)).toEqual(['ok000001']);
  });

  it('recovers foreign-session entries only into the new-session scope', () => {
    draft.saveDraftAttachments(undefined, [fileEntry({ sessionId: 's1' })]);
    expect(draft.loadDraftAttachments(undefined)).toHaveLength(1);
    draft.saveDraftAttachments('s2', [fileEntry({ sessionId: 's1' })]);
    expect(draft.loadDraftAttachments('s2')).toEqual([]);
    draft.saveDraftAttachments('s1', [fileEntry({ sessionId: 's1' })]);
    expect(draft.loadDraftAttachments('s1')).toHaveLength(1);
  });

  it('drops non-string optional fields instead of failing the entry', () => {
    globalThis.localStorage.setItem(
      draftAttachmentsStorageKey('s1'),
      JSON.stringify([{ ...fileEntry(), size: 'big', path: 7, refCount: 'x', mediaType: 42 }]),
    );
    const loaded = draft.loadDraftAttachments('s1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.size).toBeUndefined();
    expect(loaded[0]!.path).toBeUndefined();
    expect(loaded[0]!.refCount).toBe(0);
    expect(loaded[0]!.mediaType).toBeUndefined();
  });

  it('skips the sidecar write when only transient fields change', () => {
    let writes = 0;
    const backend = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        ...backend,
        setItem: (key: string, value: string) => {
          writes += 1;
          backend.setItem(key, value);
        },
      },
      configurable: true,
      writable: true,
    });
    draft.saveDraftAttachments('s1', [fileEntry({ uploadProgress: 0.1 })]);
    draft.saveDraftAttachments('s1', [fileEntry({ uploadProgress: 0.62 })]);
    draft.saveDraftAttachments('s1', [fileEntry({ uploadProgress: 0.99 })]);
    expect(writes).toBe(1);
    expect(draft.loadDraftAttachments('s1')[0]!.uploadProgress).toBeUndefined();
    draft.saveDraftAttachments('s1', [fileEntry({ size: 43 })]);
    expect(writes).toBe(2);
  });

  it('degrades draft-text attachment links whose entries did not survive', () => {
    globalThis.localStorage.setItem(
      draftStorageKey(undefined),
      '看看 [截图](kimi-code-composer://attachments/dead0001) 和 [a.pdf](kimi-code-composer://attachments/a1b2c3d4)',
    );
    globalThis.localStorage.setItem(draftAttachmentsStorageKey(undefined), JSON.stringify([fileEntry()]));
    const fresh = useComposerDraft({ sessionId: () => undefined });
    expect(fresh.text.value).toBe('看看 截图 和 [a.pdf](kimi-code-composer://attachments/a1b2c3d4)');
  });

  it('degrades every attachment link when the sidecar is absent', () => {
    globalThis.localStorage.setItem(draftStorageKey('s9'), ' draft [x.png](kimi-code-composer://attachments/zz000001)');
    const fresh = useComposerDraft({ sessionId: () => 's9' });
    expect(fresh.text.value).toBe(' draft x.png');
  });

  it('leaves draft text without attachment links untouched', () => {
    globalThis.localStorage.setItem(draftStorageKey('s9'), 'plain draft');
    const fresh = useComposerDraft({ sessionId: () => 's9' });
    expect(fresh.text.value).toBe('plain draft');
  });
});
