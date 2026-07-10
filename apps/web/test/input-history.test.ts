import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ref, type Ref } from 'vue';
import { useInputHistory } from '../src/composables/useInputHistory';
import { STORAGE_KEYS } from '../src/lib/storage';

interface MockTextarea {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange: (start: number, end: number) => void;
}

function setup(initialText = '', caret = 0, sessionId: string | null = 'test-session') {
  const textarea: MockTextarea = {
    value: initialText,
    selectionStart: caret,
    selectionEnd: caret,
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
  const text = ref(initialText);
  const textareaRef = ref(textarea as unknown as HTMLTextAreaElement) as Ref<HTMLTextAreaElement | null>;
  const history = useInputHistory({ text, textareaRef, autosize: () => {}, sessionId: () => sessionId ?? undefined });
  return { text, textarea, history };
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
    history.push('a'); // duplicate of the newest entry — must be dropped
    history.push('b');
    history.recallOlder(); // -> b
    expect(text.value).toBe('b');
    history.recallOlder(); // -> a (only one 'a' was kept)
    expect(text.value).toBe('a');
    history.recallOlder(); // already oldest — must stay, not land on a second 'a'
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
    history.recallOlder(); // -> c
    expect(text.value).toBe('c');
    expect(history.isBrowsing()).toBe(true);
    history.recallOlder(); // -> b
    expect(text.value).toBe('b');
    history.recallOlder(); // -> a
    expect(text.value).toBe('a');
    history.recallOlder(); // already oldest, stay
    expect(text.value).toBe('a');

    history.recallNewer(); // -> b
    expect(text.value).toBe('b');
    history.recallNewer(); // -> c
    expect(text.value).toBe('c');
    history.recallNewer(); // -> back to the live draft
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
    expect(text.value).toBe('a'); // the recalled entry stays as the editable text
  });
});

describe('useInputHistory — caretAtTextStart', () => {
  it('is true at the very start of the text', () => {
    const { textarea, history } = setup('hello\nworld', 0);
    textarea.value = 'hello\nworld';
    expect(history.caretAtTextStart()).toBe(true);
  });

  it('is false when the caret is on the first line but not at the start', () => {
    const { textarea, history } = setup('hello\nworld', 3);
    textarea.value = 'hello\nworld';
    expect(history.caretAtTextStart()).toBe(false);
  });

  it('is false once the caret is past the first newline', () => {
    const { textarea, history } = setup('hello\nworld', 8);
    textarea.value = 'hello\nworld';
    expect(history.caretAtTextStart()).toBe(false);
  });

  it('is true for an empty composer', () => {
    const { history } = setup('', 0);
    expect(history.caretAtTextStart()).toBe(true);
  });
});

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

describe('useInputHistory — persistence', () => {
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

    // Simulates the empty composer unmounting and the docked composer mounting.
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

    // Re-mount each session and confirm each only recalls its own entry.
    const a2 = setup('', 0, 'sess-a');
    a2.history.recallOlder();
    expect(a2.text.value).toBe('from-a');
    a2.history.recallOlder(); // no older entry — must stay
    expect(a2.text.value).toBe('from-a');

    const b2 = setup('', 0, 'sess-b');
    b2.history.recallOlder();
    expect(b2.text.value).toBe('from-b');
  });

  it('trims to the newest 100 entries, dropping the oldest', () => {
    const { text, history } = setup();
    for (let i = 0; i < 105; i++) history.push(`m${i}`);

    // Walk all the way back; the oldest kept entry must be m5 (m0..m4 dropped).
    for (let i = 0; i < 100; i++) history.recallOlder();
    expect(text.value).toBe('m5');
    history.recallOlder(); // already at the oldest kept entry — must not move
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
    history.recallOlder(); // -> old2
    expect(text.value).toBe('old2');
    history.recallOlder(); // -> old1
    expect(text.value).toBe('old1');
    // Persisted in the new map format under the current session.
    const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEYS.inputHistory)!);
    expect(stored).toEqual({ 'sess-x': ['old1', 'old2'] });
  });

  it('leaves the legacy array untouched when mounted without a session', () => {
    globalThis.localStorage.setItem(STORAGE_KEYS.inputHistory, JSON.stringify(['old1']));
    const { history } = setup('', 0, null);
    expect(history.hasHistory()).toBe(false);
    // A later docked mount (with a session id) can still migrate it.
    const { text, history: docked } = setup('', 0, 'sess-y');
    docked.recallOlder();
    expect(text.value).toBe('old1');
  });
});
