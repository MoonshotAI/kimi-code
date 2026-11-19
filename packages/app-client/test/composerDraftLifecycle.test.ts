import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  draftAttachmentsStorageKey,
  draftStorageKey,
} from '@moonshot-ai/app-core/lib';
import { stashEditorState, takeEditorState } from '../../app-composer/src/runtime/editorStateCache';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import {
  persistComposerDraftSnapshot,
  resetComposerAfterDispatch,
  type ComposerDispatchResetEffects,
} from '../src/lib/composerDraftLifecycle';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function resetEffects(calls: string[]): ComposerDispatchResetEffects {
  return {
    setText: (value) => calls.push(`text:${value}`),
    clearDraft: () => calls.push('draft'),
    clearDraftAttachments: () => calls.push('attachments'),
    closeSlashMenu: () => calls.push('slash'),
    closeMentionMenu: () => calls.push('mention'),
    collapse: () => calls.push('collapse'),
  };
}

describe('resetComposerAfterDispatch', () => {
  it('clears the full draft for message dispatch', () => {
    const calls: string[] = [];
    resetComposerAfterDispatch(resetEffects(calls), {
      attachments: 'clear',
      mentionMenu: 'close',
    });
    expect(calls).toEqual([
      'text:',
      'draft',
      'attachments',
      'slash',
      'mention',
      'collapse',
    ]);
  });

  it('preserves attachment and mention state for local commands', () => {
    const calls: string[] = [];
    resetComposerAfterDispatch(resetEffects(calls), {
      attachments: 'preserve',
      mentionMenu: 'preserve',
    });
    expect(calls).toEqual(['text:', 'draft', 'slash', 'collapse']);
  });
});

describe('persistComposerDraftSnapshot', () => {
  let original: Storage | undefined;

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

  it('persists text and serializable attachment metadata', () => {
    const entry: AttachmentEntry = {
      attId: 'a1',
      key: 'blob:a1',
      kind: 'image',
      name: 'image.png',
      refCount: 1,
      uploading: false,
      uploadProgress: 0.5,
      previewUrl: 'blob:preview',
      fileId: 'f_1',
    };
    persistComposerDraftSnapshot('s1', 'draft', [entry]);
    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBe('draft');
    expect(JSON.parse(globalThis.localStorage.getItem(draftAttachmentsStorageKey('s1')) ?? '[]')).toEqual([
      {
        attId: 'a1',
        key: 'blob:a1',
        kind: 'image',
        name: 'image.png',
        refCount: 1,
        uploading: false,
        fileId: 'f_1',
      },
    ]);
  });

  it('drops attachments that cannot be re-sent after a reload', () => {
    const entry: AttachmentEntry = {
      attId: 'a1',
      key: 'blob:a1',
      kind: 'image',
      name: 'image.png',
      refCount: 1,
      uploading: false,
      error: 'upload-interrupted',
    };
    persistComposerDraftSnapshot('s1', 'draft', [entry]);
    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBe('draft');
    expect(globalThis.localStorage.getItem(draftAttachmentsStorageKey('s1'))).toBeNull();
  });

  it.each([undefined, 's-failed'])('invalidates the cleared editor stash when restoring a rejected send (%s)', (sid) => {
    const scope = sid ?? '__new__';
    stashEditorState(scope, {} as Parameters<typeof stashEditorState>[1]);
    persistComposerDraftSnapshot(sid, 'restored prompt');
    expect(takeEditorState(scope)).toBeUndefined();
    expect(globalThis.localStorage.getItem(draftStorageKey(sid))).toBe('restored prompt');
  });

  it('clears empty buckets', () => {
    globalThis.localStorage.setItem(draftStorageKey('s1'), 'old');
    globalThis.localStorage.setItem(draftAttachmentsStorageKey('s1'), '[]');
    persistComposerDraftSnapshot('s1', '', []);
    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBeNull();
    expect(globalThis.localStorage.getItem(draftAttachmentsStorageKey('s1'))).toBeNull();
  });
});
