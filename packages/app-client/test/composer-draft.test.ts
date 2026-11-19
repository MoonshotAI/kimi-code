import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { sessionListStore } from '../src/stores/sessionList';
import { persistComposerDraftSnapshot } from '../src/lib/composerDraftLifecycle';
import { useComposerDraft } from '../src/composables';
import { draftSnapshotStorageKey, draftStorageKey } from '@moonshot-ai/app-core/lib';
import { attachmentNode, composerSchema, composerSnapshotDocument, createComposerSnapshot, quoteNode } from '@moonshot-ai/app-composer/model';

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

function setup(initialSid: string | undefined) {
  const sid = ref(initialSid);
  const draft = useComposerDraft({ sessionId: () => sid.value });
  return {
    draft,
    text: draft.text,
    setSid: (next: string | undefined) => {
      sid.value = next;
    },
  };
}

describe('useComposerDraft', () => {
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
    vi.restoreAllMocks();
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

  it('loads the stored draft for the session on init', () => {
    globalThis.localStorage.setItem(draftStorageKey('s1'), 'saved draft');
    const { text } = setup('s1');
    expect(text.value).toBe('saved draft');
  });

  it('restores a rich document from storage without reparsing its literal Markdown', () => {
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [
      composerSchema.text('[literal](file.md) '),
      quoteNode({ text: 'source', comment: 'comment', source: 'example.ts:3' }),
    ])]);
    const { draft } = setup('s1');
    draft.saveDraftSnapshot('s1', createComposerSnapshot(doc, [], []));
    const reopened = setup('s1');
    const restored = reopened.draft.loadDraftSnapshot('s1');
    expect(restored).not.toBeNull();
    expect(composerSnapshotDocument(restored!).eq(doc)).toBe(true);
    expect(reopened.text.value).toContain('[literal](file.md)');
  });

  it('restores a draft without attachments whose upload was interrupted', () => {
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [
      attachmentNode({ attId: 'uploading', name: 'draft.png', kind: 'image' }),
      composerSchema.text(' '),
      attachmentNode({ attId: 'done', name: 'done.pdf', kind: 'file' }),
      composerSchema.text(' '),
      attachmentNode({ attId: 'shot', name: 'shot.png', kind: 'image' }),
    ])]);
    const entries = [
      { attId: 'uploading', key: 'blob:uploading', kind: 'image' as const, name: 'draft.png', refCount: 0, uploading: true },
      { attId: 'done', key: 'blob:done', kind: 'file' as const, name: 'done.pdf', refCount: 0, uploading: false, fileId: 'file-done', sessionId: 's1' },
      { attId: 'shot', key: 'blob:shot', kind: 'image' as const, name: 'shot.png', refCount: 0, uploading: true, purpose: 'browser-screenshot' as const },
    ];
    setup('s1').draft.saveDraftSnapshot('s1', createComposerSnapshot(doc, entries, ['uploading', 'done', 'shot']));
    const reopened = setup('s1').draft;
    expect(reopened.loadDraftSnapshot('s1')?.attachmentOrder).toEqual(['uploading', 'done', 'shot']);
    const restored = reopened.loadRestorableDraftSnapshot('s1')!;
    expect(restored.attachments.map((entry) => entry.attId)).toEqual(['done', 'shot']);
    expect(restored.attachmentOrder).toEqual(['done', 'shot']);
    const pills: string[] = [];
    composerSnapshotDocument(restored).descendants((node) => { if (node.type.name === 'attachment') pills.push(node.attrs.attId as string); });
    expect(pills).toEqual(['done', 'shot']);
    expect(composerSnapshotDocument(restored).textContent).toContain('draft.png');
  });

  it('restores a successful pasted-image pill once and degrades unfinished or failed image pills', () => {
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [
      attachmentNode({ attId: 'ready', name: 'ready.png', kind: 'image' }),
      composerSchema.text(' '),
      attachmentNode({ attId: 'uploading', name: 'uploading.png', kind: 'image' }),
      composerSchema.text(' '),
      attachmentNode({ attId: 'failed', name: 'failed.png', kind: 'image' }),
      composerSchema.text(' '),
      attachmentNode({ attId: 'missing', name: 'missing.png', kind: 'image' }),
    ])]);
    const entries = [
      { attId: 'ready', key: 'blob:ready', kind: 'image' as const, name: 'ready.png', refCount: 1, uploading: false, fileId: 'file-ready' },
      { attId: 'uploading', key: 'blob:uploading', kind: 'image' as const, name: 'uploading.png', refCount: 1, uploading: true },
      { attId: 'failed', key: 'blob:failed', kind: 'image' as const, name: 'failed.png', refCount: 1, uploading: false, error: 'upload-failed' as const },
      { attId: 'missing', key: 'blob:missing', kind: 'image' as const, name: 'missing.png', refCount: 1, uploading: false },
    ];
    setup('s1').draft.saveDraftSnapshot('s1', createComposerSnapshot(doc, entries, ['ready', 'uploading', 'failed', 'missing']));

    const restored = setup('s1').draft.loadRestorableDraftSnapshot('s1')!;
    expect(restored.attachments.map((entry) => entry.attId)).toEqual(['ready']);
    expect(restored.attachmentOrder).toEqual(['ready']);
    const pills: string[] = [];
    composerSnapshotDocument(restored).descendants((node) => {
      if (node.type.name === 'attachment') pills.push(node.attrs.attId as string);
    });
    expect(pills).toEqual(['ready']);
    expect(composerSnapshotDocument(restored).textContent).toBe('[ready.png](kimi-code-composer://attachments/ready) uploading.png failed.png missing.png');
  });

  it('does not restore rich snapshots after a deleted session is persisted during teardown', () => {
    const { draft } = setup('deleted-session');
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [quoteNode({ text: 'source' })])]);
    const snapshot = createComposerSnapshot(doc, [], []);
    draft.saveDraftSnapshot('deleted-session', snapshot);
    vi.spyOn(sessionListStore(), 'hasDeletedTombstone').mockReturnValue(true);
    draft.saveDraftSnapshot('deleted-session', snapshot);
    expect(localStorage.getItem(draftSnapshotStorageKey('deleted-session'))).toBeNull();
    persistComposerDraftSnapshot('deleted-session', 'late draft', [], snapshot);
    expect(localStorage.getItem(draftSnapshotStorageKey('deleted-session'))).toBeNull();
    expect(localStorage.getItem(draftStorageKey('deleted-session'))).toBeNull();
  });

  it('keeps rich snapshots scoped to their own drafts when switching sessions', async () => {
    const { draft, text, setSid } = setup('s1');
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [quoteNode({ text: 'source', comment: 's1 comment' })])]);
    draft.saveDraftSnapshot('s1', createComposerSnapshot(doc, [], []));
    text.value = draft.loadDraftSnapshot('s1') ? doc.textContent : '';
    await nextTick();
    setSid('s2');
    await nextTick();
    expect(draft.loadDraftSnapshot('s1')).not.toBeNull();
    expect(draft.loadDraftSnapshot('s2')).toBeNull();
    expect(text.value).toBe('');
  });

  it('invalidates an obsolete snapshot when text is replaced outside the editor', async () => {
    const { draft, text } = setup('s1');
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [quoteNode({ text: 'source' })])]);
    draft.saveDraftSnapshot('s1', createComposerSnapshot(doc, [], []));
    text.value = 'replacement';
    await nextTick();
    expect(draft.loadDraftSnapshot('s1')).toBeNull();
    expect(setup('s1').text.value).toBe('replacement');
  });

  it('clears a media-only snapshot and tolerates malformed persisted data', () => {
    const { draft } = setup('s1');
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph')]);
    draft.saveDraftSnapshot('s1', createComposerSnapshot(doc, [], ['missing-image']));
    expect(draft.loadDraftSnapshot('s1')?.attachmentOrder).toEqual(['missing-image']);
    draft.clearDraft();
    expect(globalThis.localStorage.getItem(draftSnapshotStorageKey('s1'))).toBeNull();
    globalThis.localStorage.setItem(draftSnapshotStorageKey('s1'), '{broken');
    globalThis.localStorage.setItem(draftStorageKey('s1'), 'retained text');
    expect(setup('s1').text.value).toBe('retained text');
  });

  it('starts empty when the session has no stored draft', () => {
    const { text } = setup('s1');
    expect(text.value).toBe('');
  });

  it('persists the draft when the text changes', async () => {
    const { text } = setup('s1');
    text.value = 'hello';
    await nextTick();
    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBe('hello');
  });

  it('clears the stored draft when the text is emptied', async () => {
    globalThis.localStorage.setItem(draftStorageKey('s1'), 'x');
    const { text } = setup('s1');
    text.value = '';
    await nextTick();
    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBeNull();
  });

  it('runs onBeforeSessionSave BEFORE persisting the outgoing draft (the callback can repair the text being saved)', async () => {
    const sid = ref('s1');
    const draft = useComposerDraft({
      sessionId: () => sid.value,
      onBeforeSessionSave: () => {
        draft.text.value = 'real draft';
      },
    });
    draft.text.value = 'recall text';
    await nextTick();

    sid.value = 's2';
    await nextTick();

    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBe('real draft');
    expect(draft.text.value).toBe('');
  });

  it('saves the old draft and loads the new one on session switch', async () => {
    const { text, setSid } = setup('s1');
    text.value = 'draft-s1';
    await nextTick();
    globalThis.localStorage.setItem(draftStorageKey('s2'), 'draft-s2');

    setSid('s2');
    await nextTick();

    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBe('draft-s1');
    expect(text.value).toBe('draft-s2');
  });

  it('loadForEdit replaces the text', () => {
    const { draft } = setup('s1');
    draft.loadForEdit('edit me');
    expect(draft.text.value).toBe('edit me');
  });

  it('loadForEdit focuses the editing surface and places the caret at the end', async () => {
    const { draft } = setup('s1');
    const ranges: Array<[number, number]> = [];
    let focused = false;
    draft.editorRef.value = {
      selectionStart: 0,
      selectionEnd: 0,
      setSelectionRange: (start: number, end: number) => {
        ranges.push([start, end]);
      },
      focus: () => {
        focused = true;
      },
    };
    draft.loadForEdit('edit me');
    await nextTick();
    expect(focused).toBe(true);
    expect(ranges).toEqual([['edit me'.length, 'edit me'.length]]);
  });

  it('clearDraft removes the persisted draft synchronously', async () => {
    globalThis.localStorage.setItem(draftStorageKey('s1'), 'stale draft');
    const { draft } = setup('s1');
    draft.clearDraft();
    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBeNull();

    const { text } = setup('s1');
    expect(text.value).toBe('');
    await nextTick();
    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBeNull();
  });
});
