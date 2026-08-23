// packages/app-client/test/composer-draft-attachments.test.ts
// The attachment-entry sidecar of useComposerDraft (desktop-only): registry
// entries persist per session next to the text draft, so a restart re-seeds
// the metadata behind the revived draft's attachment pills. Web never calls
// these — the plain-text draft format is untouched.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useComposerDraft } from '../src/composables';
import { draftAttachmentsStorageKey } from '@moonshot-ai/app-core/lib';
import type { AttachmentEntry } from '@moonshot-ai/app-composer';

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
  const draft = useComposerDraft({ sessionId: () => undefined });

  beforeEach(() => {
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
      fileEntry({ mediaType: 'application/pdf', seq: 7 }),
      fileEntry({ attId: 'f0ld3r00', key: 'file:///docs/', kind: 'folder', name: 'docs/', path: '/docs', fileId: undefined }),
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
        { attId: 'x' }, // missing key/name/kind
        { attId: 'y', key: 'k', name: 'n', kind: 'image' }, // bad kind
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

  it('marks an entry whose upload was in flight as interrupted instead of stuck-uploading', () => {
    // A reload kills the in-flight upload for good — restoring `uploading:
    // true` would block the composer's send gate forever, so the entry comes
    // back with an error marker (excluded from the submit payload).
    draft.saveDraftAttachments('s1', [fileEntry({ uploading: true, fileId: undefined })]);
    const loaded = draft.loadDraftAttachments('s1');
    expect(loaded[0]!.uploading).toBe(false);
    expect(loaded[0]!.error).toBe('upload-interrupted');
  });

  it('keeps an explicit error marker over the interrupted default', () => {
    draft.saveDraftAttachments('s1', [fileEntry({ uploading: true, error: 'upload-failed' })]);
    expect(draft.loadDraftAttachments('s1')[0]!.error).toBe('upload-failed');
  });

  it('drops non-string optional fields instead of failing the entry', () => {
    globalThis.localStorage.setItem(
      draftAttachmentsStorageKey('s1'),
      JSON.stringify([{ ...fileEntry(), size: 'big', path: 7, refCount: 'x', mediaType: 42, seq: 'soon' }]),
    );
    const loaded = draft.loadDraftAttachments('s1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.size).toBeUndefined();
    expect(loaded[0]!.path).toBeUndefined();
    expect(loaded[0]!.refCount).toBe(0);
    expect(loaded[0]!.mediaType).toBeUndefined();
    expect(loaded[0]!.seq).toBeUndefined();
  });
});
