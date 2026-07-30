import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import { useMentionMenu } from '../../src/renderer/composables/useMentionMenu';
import type { FileItem } from '../../src/renderer/types';

interface MockTextarea {
  value: string;
  selectionStart: number;
  setSelectionRange: (start: number, end: number) => void;
  focus: () => void;
}

function setup(initialText = '', searchFiles?: (q: string) => Promise<FileItem[]>) {
  const textarea: MockTextarea = {
    value: initialText,
    // Caret defaults to the end of the text.
    selectionStart: initialText.length,
    setSelectionRange(start: number) {
      this.selectionStart = start;
    },
    focus: () => {},
  };
  const text = ref(initialText);
  const textareaRef = ref(textarea as unknown as HTMLTextAreaElement) as Ref<HTMLTextAreaElement | null>;
  const mention = useMentionMenu({
    text,
    textareaRef,
    autosize: () => {},
    searchFiles: () => searchFiles,
  });
  return { text, textarea, mention };
}

describe('useMentionMenu — update', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays closed when there is no @token', async () => {
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { mention } = setup('hello', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.open.value).toBe(false);
    expect(searchFiles).not.toHaveBeenCalled();
  });

  it('stays closed when searchFiles is not provided', async () => {
    const { mention } = setup('@a');
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.open.value).toBe(false);
  });

  it('stays closed with a bare @ and does not search', async () => {
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { mention } = setup('@', searchFiles);
    mention.update();
    // No debounce, no request: the menu only opens for a real query.
    expect(mention.open.value).toBe(false);
    expect(mention.items.value).toEqual([]);
    expect(mention.loading.value).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(searchFiles).not.toHaveBeenCalled();
  });

  it('closes without searching when the query is deleted back to a bare @', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { text, textarea, mention } = setup('@a', searchFiles);
    mention.update();
    // Backspace the 'a' before the debounce fires.
    text.value = '@';
    textarea.value = '@';
    textarea.selectionStart = 1;
    mention.update();
    await vi.advanceTimersByTimeAsync(500);
    expect(searchFiles).not.toHaveBeenCalled();
    expect(mention.open.value).toBe(false);
  });

  it('stays closed when the @token is deleted before the debounce fires', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { text, textarea, mention } = setup('@a', searchFiles);
    mention.update();
    // Delete the whole token before the debounce fires.
    text.value = '';
    textarea.value = '';
    textarea.selectionStart = 0;
    mention.update();
    await vi.advanceTimersByTimeAsync(500);
    expect(searchFiles).not.toHaveBeenCalled();
    expect(mention.open.value).toBe(false);
  });

  it('ignores in-flight results that resolve after backspacing to a bare @', async () => {
    let resolveSearch: (items: FileItem[]) => void = () => {};
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolveSearch = resolve; }),
    );
    const { text, textarea, mention } = setup('@a', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200); // search fires
    expect(searchFiles).toHaveBeenCalledWith('a');
    // Backspace to a bare @ while the search is in flight.
    text.value = '@';
    textarea.value = '@';
    textarea.selectionStart = 1;
    mention.update();
    resolveSearch([{ path: 'src/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    // The stale response must not reopen or repopulate the menu.
    expect(mention.open.value).toBe(false);
    expect(mention.items.value).toEqual([]);
    expect(mention.loading.value).toBe(false);
  });

  it('opens with search results after the debounce', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@a', searchFiles);
    mention.update();
    expect(mention.open.value).toBe(false); // debounced, not yet
    await vi.advanceTimersByTimeAsync(200);
    expect(searchFiles).toHaveBeenCalledWith('a');
    expect(mention.open.value).toBe(true);
    expect(mention.items.value).toEqual([{ path: 'src/a.ts', name: 'a.ts' }]);
    expect(mention.loading.value).toBe(false);
    expect(mention.active.value).toBe(0);
  });

  it('clears items and stops loading when the search throws', async () => {
    const searchFiles = vi.fn().mockRejectedValue(new Error('boom'));
    const { mention } = setup('@a', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.items.value).toEqual([]);
    expect(mention.loading.value).toBe(false);
  });
});

describe('useMentionMenu — select', () => {
  it('replaces the @token with the chosen path', async () => {
    const { text, textarea, mention } = setup('hello @a');
    textarea.value = 'hello @a';
    mention.select({ path: 'src/a.ts', name: 'a.ts' });
    expect(text.value).toBe('hello src/a.ts');
    expect(mention.open.value).toBe(false);
    await nextTick();
  });

  it('is a no-op when there is no @token', () => {
    const { text, mention } = setup('hello');
    mention.select({ path: 'src/a.ts', name: 'a.ts' });
    expect(text.value).toBe('hello');
  });
});
