import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import { useComposerDraft, useInputHistory, forgetInputHistory } from '../src/composables';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import type { TextFieldLike } from '@moonshot-ai/app-composer/runtime';
import { browserReferenceNode, composerSchema, createComposerSnapshot, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import type { BrowserCapture } from '@moonshot-ai/app-core/browser-reference';

interface MockEditor {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange: (start: number, end: number) => void;
}

function setup(initialText = '', caret = 0, sessionId: string | null = 'test-session') {
  const editor: MockEditor = {
    value: initialText,
    selectionStart: caret,
    selectionEnd: caret,
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
  const text = ref(initialText);
  const editorRef = ref(editor as unknown as TextFieldLike) as Ref<TextFieldLike | null>;
  const history = useInputHistory({ text, editorRef, sessionId: () => sessionId ?? undefined });
  return { text, editor, history };
}

describe('useInputHistory — push', () => {
  it('ignores empty or whitespace-only entries', () => {
    const { history } = setup();
    history.push('');
    history.push('   ');
    expect(history.hasHistory()).toBe(false);
  });

  it('appends distinct entries newest-last', () => {
    const { history } = setup();
    history.push('a');
    history.push('b');
    history.push('c');
    expect(history.hasHistory()).toBe(true);
  });

  it('skips a consecutive duplicate', () => {
    const { text, history } = setup();
    history.push('a');
    history.push('a');
    history.push('b');
    history.recallOlder();
    expect(text.value).toBe('b');
    history.recallOlder();
    expect(text.value).toBe('a');
    history.recallOlder();
    expect(text.value).toBe('a');
  });

  it('drops entries pushed without a session (draft / empty composer)', () => {
    const { history } = setup('', 0, null);
    history.push('hello');
    expect(history.hasHistory()).toBe(false);
  });
});

describe('useInputHistory — recall', () => {
  it('walks backward from the most recent entry, then restores the live draft', () => {
    const { text, history } = setup('draft');
    history.push('a');
    history.push('b');
    history.push('c');

    expect(history.isBrowsing()).toBe(false);
    history.recallOlder();
    expect(text.value).toBe('c');
    expect(history.isBrowsing()).toBe(true);
    history.recallOlder();
    expect(text.value).toBe('b');
    history.recallOlder();
    expect(text.value).toBe('a');
    history.recallOlder();
    expect(text.value).toBe('a');

    history.recallNewer();
    expect(text.value).toBe('b');
    history.recallNewer();
    expect(text.value).toBe('c');
    history.recallNewer();
    expect(text.value).toBe('draft');
    expect(history.isBrowsing()).toBe(false);
  });

  it('restores an empty live draft after recalling the single newest entry', () => {
    const { text, history } = setup('');
    history.push('only');
    history.recallOlder();
    expect(text.value).toBe('only');
    history.recallNewer();
    expect(text.value).toBe('');
  });

  it('does nothing when recalling with an empty history', () => {
    const { text, history } = setup('draft');
    history.recallOlder();
    history.recallNewer();
    expect(text.value).toBe('draft');
    expect(history.isBrowsing()).toBe(false);
  });

  it('resetBrowsing drops out of history mode without changing text', () => {
    const { text, history } = setup('draft');
    history.push('a');
    history.recallOlder();
    expect(history.isBrowsing()).toBe(true);
    history.resetBrowsing();
    expect(history.isBrowsing()).toBe(false);
    expect(text.value).toBe('a');
  });
});

describe('useInputHistory — canRecallOlder (the ArrowUp gate)', () => {
  it('is false without history even when the draft is empty', () => {
    const { history } = setup('');
    expect(history.canRecallOlder()).toBe(false);
  });

  it('is true with history and an empty draft', () => {
    const { history } = setup('');
    history.push('a');
    expect(history.canRecallOlder()).toBe(true);
  });

  it('is false with history when the draft has content — recall never hijacks the caret', () => {
    const { history } = setup('draft');
    history.push('a');
    expect(history.canRecallOlder()).toBe(false);
  });

  it('treats a whitespace-only draft as content', () => {
    const { history } = setup('  \n ');
    history.push('a');
    expect(history.canRecallOlder()).toBe(false);
  });

  it('stays true once browsing even though the recalled text fills the composer', () => {
    const { text, history } = setup('');
    history.push('a');
    history.push('b');
    history.recallOlder();
    expect(text.value).toBe('b');
    expect(history.canRecallOlder()).toBe(true);
  });

  it('follows the draft back to empty after walking home', () => {
    const { history } = setup('');
    history.push('a');
    history.recallOlder();
    history.recallNewer();
    expect(history.canRecallOlder()).toBe(true);
  });

  it('becomes false once an edited recalled entry exits browsing', () => {
    const { history } = setup('');
    history.push('a');
    history.recallOlder();
    history.resetBrowsing();
    expect(history.canRecallOlder()).toBe(false);
  });
});

function richHistorySnapshot(comment = 'Rename it'): ComposerDocumentSnapshot {
  const capture: BrowserCapture = {
    version: 1, id: 'capture-example', ordinal: 1, label: 'Save button', capturedAt: '2026-09-07T00:00:00.000Z',
    page: { url: 'https://example.test', title: 'Example' },
    target: { kind: 'element', tagName: 'button', bounds: { x: 1, y: 1, width: 50, height: 20 } },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 1 },
    screenshot: { attachmentId: 'shot', crop: { x: 1, y: 1, width: 50, height: 20 }, pixelWidth: 50, pixelHeight: 20 },
  };
  const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [composerSchema.text('[literal](example.md) '), browserReferenceNode({ refId: 'ref-example', label: capture.label })])]);
  return createComposerSnapshot(doc, [{ attId: 'shot', key: 'blob:shot', kind: 'image', name: 'shot.png', purpose: 'browser-screenshot', fileId: 'image-example', refCount: 0, uploading: false }], ['shot'], { references: [{ id: 'ref-example', captureId: capture.id, comment }], captures: [capture] });
}

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

describe('useInputHistory — session switch', () => {
  it('walks home before dropping the cursor: a mid-browse switch restores the pre-browse draft text', async () => {
    const sid = ref('session-a');
    const editor: MockEditor = {
      value: 'original draft',
      selectionStart: 0,
      selectionEnd: 0,
      setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
    };
    const text = ref('original draft');
    const editorRef = ref(editor as unknown as TextFieldLike) as Ref<TextFieldLike | null>;
    const history = useInputHistory({ text, editorRef, sessionId: () => sid.value });
    history.push('older entry');
    history.recallOlder();
    expect(text.value).toBe('older entry');
    expect(history.isBrowsing()).toBe(true);

    sid.value = 'session-b';
    await nextTick();
    expect(text.value).toBe('original draft');
    expect(history.isBrowsing()).toBe(false);
  });
});

describe('useInputHistory — persistence', () => {
it('bounds serialized input history across sessions and keeps newest usable input', () => {
  const sid = ref('first');
  const text = ref('');
  const history = useInputHistory({ text, editorRef: ref(null), sessionId: () => sid.value });
  for (let i = 0; i < 20; i++) { sid.value = `session-${i}`; history.push(`${i}${'文'.repeat(100_000)}`); }
  history.push('newest');
  const saved = localStorage.getItem(STORAGE_KEYS.inputHistory)!;
  expect(saved.length * 2).toBeLessThanOrEqual(1024 * 1024);
  history.recallOlder();
  expect(text.value).toBe('newest');
});

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

  it('restores the exact rich document, comments and screenshot inventory after remount', () => {
    const first = setup();
    const snapshot = richHistorySnapshot();
    first.history.push('wire text', snapshot);
    snapshot.browserReferences![0]!.comment = 'later mutation';
    const onRecall = vi.fn();
    const second = useInputHistory({ text: ref(''), editorRef: ref(null), sessionId: () => 'test-session', onRecall });
    second.recallOlder();
    const restored = onRecall.mock.calls[0]![1] as ComposerDocumentSnapshot;
    expect(restored).toEqual(richHistorySnapshot());
    expect(restored.doc.content![0]!.content![0]!.type).toBe('text');
    expect(second.isBrowsing()).toBe(true);
  });

  it('restores unsent browser references and capture records when leaving history', () => {
    const draft = richHistorySnapshot('unsent comment');
    draft.browserReferences![0]!.includeScreenshot = false;
    const onRecall = vi.fn();
    const history = useInputHistory({ text: ref(''), editorRef: ref(null), sessionId: () => 'test-session', getSnapshot: () => draft, onRecall });
    history.push('older entry', richHistorySnapshot('older'));
    history.recallOlder();
    history.restoreDraft();
    const restored = onRecall.mock.calls.at(-1)![1] as ComposerDocumentSnapshot;
    expect(restored.browserReferences).toEqual(draft.browserReferences);
    expect(restored.browserCaptures).toEqual(draft.browserCaptures);
    expect(restored.doc).toEqual(draft.doc);
  });

  it('keeps records with identical pills but different comments distinct and restores the live draft', () => {
    const text = ref('');
    const onRecall = vi.fn();
    const draft = createComposerSnapshot(composerSchema.node('doc', null, [composerSchema.node('paragraph')]), [], []);
    const history = useInputHistory({ text, editorRef: ref(null), sessionId: () => 'test-session', onRecall, getSnapshot: () => draft });
    history.push('same wire', richHistorySnapshot('first'));
    history.push('same wire', richHistorySnapshot('second'));
    history.recallOlder();
    history.recallOlder();
    expect(onRecall.mock.calls.map((call) => (call[1] as ComposerDocumentSnapshot).browserReferences?.[0]?.comment)).toEqual(['second', 'first']);
    history.recallNewer();
    history.recallNewer();
    expect(onRecall.mock.lastCall?.[1]).toEqual(draft);
    expect(text.value).toBe('');
    expect(history.isBrowsing()).toBe(false);
  });

  it('retains media-only snapshots in history and validates malformed stored entries', () => {
    const source = richHistorySnapshot();
    const snapshot = createComposerSnapshot(composerSchema.node('doc', null, [composerSchema.node('paragraph')]), [{ ...source.attachments[0]!, purpose: undefined }], ['shot']);
    const onRecall = vi.fn();
    const history = useInputHistory({ text: ref(''), editorRef: ref(null), sessionId: () => 'test-session', onRecall });
    history.push('', snapshot);
    history.recallOlder();
    expect(onRecall.mock.lastCall?.[1]?.attachments[0]?.fileId).toBe('image-example');
    globalThis.localStorage.setItem(STORAGE_KEYS.inputHistory, JSON.stringify({ broken: 9, 'test-session': [null, { text: 2 }, { text: 'recover this', snapshot: { version: 99 } }] }));
    const restored = setup();
    restored.history.recallOlder();
    expect(restored.text.value).toBe('recover this');
  });

  it('restores the departing rich draft before saving it under its original session', async () => {
    const sid = ref('test-session');
    const original = richHistorySnapshot('unsent draft');
    let current = original;
    let history: ReturnType<typeof useInputHistory>;
    const draft = useComposerDraft({ sessionId: () => sid.value, onBeforeSessionSave: (oldSid) => {
      history.restoreDraft(oldSid);
      draft.saveDraftSnapshot(oldSid, current);
    } });
    const recalls: Array<string | undefined> = [];
    history = useInputHistory({ text: draft.text, editorRef: ref(null), sessionId: () => sid.value, getSnapshot: () => current,
      onRecall: (_value, snapshot, owner) => { recalls.push(owner); current = snapshot!; },
    });
    history.push('older', richHistorySnapshot('history'));
    history.recallOlder();
    sid.value = 'other-session';
    await nextTick();
    expect(recalls).toEqual(['test-session', 'test-session']);
    expect(draft.loadDraftSnapshot('test-session')).toEqual(original);
    expect(draft.loadDraftSnapshot('other-session')).toBeNull();
    expect(draft.text.value).toBe('');
  });

  it('does not restore old snapshots or move the new editor caret after a session switch', async () => {
    const sid = ref('test-session');
    const onRecall = vi.fn();
    const setSelectionRange = vi.fn();
    const editorRef = ref({ setSelectionRange } as unknown as TextFieldLike);
    const history = useInputHistory({ text: ref(''), editorRef, sessionId: () => sid.value, onRecall });
    history.push('wire', richHistorySnapshot());
    history.recallOlder();
    sid.value = 'other-session';
    await nextTick();
    expect(onRecall).toHaveBeenCalledTimes(1);
    expect(setSelectionRange).not.toHaveBeenCalled();
    expect(history.isBrowsing()).toBe(false);
  });

  it('does not restore a deleted side-chat history when another composer writes', () => {
    const side = useInputHistory({ text: ref(''), editorRef: ref(null), sessionId: () => 'side-chat' });
    side.push('side draft');
    const main = setup();
    main.history.push('first');
    forgetInputHistory('side-chat');
    main.history.push('second');
    expect(JSON.parse(globalThis.localStorage.getItem(STORAGE_KEYS.inputHistory)!)).toEqual({ 'test-session': ['first', 'second'] });
  });

  it('writes each pushed entry to localStorage under its session', () => {
    const { history } = setup();
    history.push('hello');
    const stored = globalThis.localStorage.getItem(STORAGE_KEYS.inputHistory);
    expect(stored).toBe(JSON.stringify({ 'test-session': ['hello'] }));
  });

  it('a freshly mounted composable reads back the persisted history', () => {
    const first = setup();
    first.history.push('a');
    first.history.push('b');

    const second = setup();
    second.history.recallOlder();
    expect(second.text.value).toBe('b');
    second.history.recallOlder();
    expect(second.text.value).toBe('a');
  });

  it('keeps histories of different sessions isolated', () => {
    const a = setup('', 0, 'sess-a');
    a.history.push('from-a');
    const b = setup('', 0, 'sess-b');
    b.history.push('from-b');

    const a2 = setup('', 0, 'sess-a');
    a2.history.recallOlder();
    expect(a2.text.value).toBe('from-a');
    a2.history.recallOlder();
    expect(a2.text.value).toBe('from-a');

    const b2 = setup('', 0, 'sess-b');
    b2.history.recallOlder();
    expect(b2.text.value).toBe('from-b');
  });

  it('trims to the newest 100 entries, dropping the oldest', () => {
    const { text, history } = setup();
    for (let i = 0; i < 105; i++) history.push(`m${i}`);

    for (let i = 0; i < 100; i++) history.recallOlder();
    expect(text.value).toBe('m5');
    history.recallOlder();
    expect(text.value).toBe('m5');
  });

  it('ignores a malformed stored value and starts empty', () => {
    globalThis.localStorage.setItem(STORAGE_KEYS.inputHistory, 'not-json');
    const { history } = setup();
    expect(history.hasHistory()).toBe(false);
  });

  it('migrates a legacy global array into the current session once', () => {
    globalThis.localStorage.setItem(STORAGE_KEYS.inputHistory, JSON.stringify(['old1', 'old2']));
    const { text, history } = setup('', 0, 'sess-x');
    history.recallOlder();
    expect(text.value).toBe('old2');
    history.recallOlder();
    expect(text.value).toBe('old1');
    const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEYS.inputHistory)!);
    expect(stored).toEqual({ 'sess-x': ['old1', 'old2'] });
  });

  it('leaves the legacy array untouched when mounted without a session', () => {
    globalThis.localStorage.setItem(STORAGE_KEYS.inputHistory, JSON.stringify(['old1']));
    const { history } = setup('', 0, null);
    expect(history.hasHistory()).toBe(false);
    const { text, history: docked } = setup('', 0, 'sess-y');
    docked.recallOlder();
    expect(text.value).toBe('old1');
  });
});


describe('media-only drafts', () => {
  it('keeps attachments out of text-history recall until the draft is empty', () => {
    const text = ref('');
    const hasAttachments = ref(true);
    const history = useInputHistory({
      text, editorRef: ref(null), sessionId: () => 'with-media',
      hasAttachments: () => hasAttachments.value,
    });
    history.push('older prompt');
    expect(history.canRecallOlder()).toBe(false);
    history.recallOlder();
    expect(history.isBrowsing()).toBe(false);
    expect(text.value).toBe('');
    hasAttachments.value = false;
    expect(history.canRecallOlder()).toBe(true);
    history.recallOlder();
    expect(text.value).toBe('older prompt');
  });
});
