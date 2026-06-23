import { describe, expect, it } from 'vitest';
import { ref, type Ref } from 'vue';
import { useInputHistory } from '../src/composables/useInputHistory';

interface MockTextarea {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange: (start: number, end: number) => void;
}

function setup(initialText = '', caret = 0) {
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
  const history = useInputHistory({ text, textareaRef, autosize: () => {} });
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

describe('useInputHistory — caretAtFirstLine', () => {
  it('is true at the very start of the text', () => {
    const { textarea, history } = setup('hello\nworld', 0);
    textarea.value = 'hello\nworld';
    expect(history.caretAtFirstLine()).toBe(true);
  });

  it('is true when the caret sits before any newline', () => {
    const { textarea, history } = setup('hello\nworld', 3);
    textarea.value = 'hello\nworld';
    expect(history.caretAtFirstLine()).toBe(true);
  });

  it('is false once the caret is past the first newline', () => {
    const { textarea, history } = setup('hello\nworld', 8);
    textarea.value = 'hello\nworld';
    expect(history.caretAtFirstLine()).toBe(false);
  });

  it('is true for an empty composer', () => {
    const { history } = setup('', 0);
    expect(history.caretAtFirstLine()).toBe(true);
  });
});
