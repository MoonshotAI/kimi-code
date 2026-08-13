import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { useComposerDraft } from '../src/composables';
import { draftStorageKey } from '@moonshot-ai/app-core/lib';

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
    // Regression: when the first message of an empty session is submitted, the
    // optimistic user turn unmounts the composer before the post-flush text
    // watcher can clear the draft. clearDraft must therefore clear it
    // synchronously so a remount does not reload the stale text.
    globalThis.localStorage.setItem(draftStorageKey('s1'), 'stale draft');
    const { draft } = setup('s1');
    draft.clearDraft();
    // No nextTick — the write is synchronous.
    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBeNull();

    // Simulate the remount after the optimistic turn: a fresh composable
    // instance for the same session should start empty, not restore the draft.
    const { text } = setup('s1');
    expect(text.value).toBe('');
    await nextTick();
    expect(globalThis.localStorage.getItem(draftStorageKey('s1'))).toBeNull();
  });
});
