import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import type { FileItem } from '@moonshot-ai/app-core/client';
import { useMentionMenu } from '../src/composables';
import type { TextFieldLike } from '../src/lib/textField';

// The debounced mention search must not outlive a close: blur / session
// switch / submit all close the menu, and a pending (or in-flight) search
// must never reopen it afterwards.

interface MockEditor {
  selectionStart: number;
  setSelectionRange: (start: number, end: number) => void;
  focus: () => void;
}

function setup(initialText: string, search?: (q: string) => Promise<FileItem[]>) {
  const editor: MockEditor = {
    // Caret sits at the end of the text, right after the @token.
    selectionStart: initialText.length,
    setSelectionRange(start: number) {
      this.selectionStart = start;
    },
    focus: () => {},
  };
  const text = ref(initialText);
  const editorRef = ref(editor as unknown as TextFieldLike) as Ref<TextFieldLike | null>;
  const mention = useMentionMenu({ text, editorRef, searchFiles: () => search });
  return { text, editor, mention };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMentionMenu — close', () => {
  it('cancels a pending debounced search so the menu never opens', async () => {
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@a', search);

    mention.update();
    // Close inside the 200ms debounce window (e.g. the composer blurred).
    mention.close();
    await vi.advanceTimersByTimeAsync(300);

    expect(mention.open.value).toBe(false);
    expect(mention.loading.value).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it('drops an in-flight search result instead of applying it', async () => {
    let resolveSearch: (items: FileItem[]) => void = () => {};
    const search = vi.fn(
      () =>
        new Promise<FileItem[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const { mention } = setup('@a', search);

    mention.update();
    await vi.advanceTimersByTimeAsync(250);
    // The debounce fired: menu open, search in flight.
    expect(mention.open.value).toBe(true);
    expect(mention.loading.value).toBe(true);

    mention.close();
    expect(mention.open.value).toBe(false);
    expect(mention.loading.value).toBe(false);

    resolveSearch([{ path: 'src/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(mention.open.value).toBe(false);
    expect(mention.items.value).toEqual([]);
  });

  it('still opens and loads results when left alone', async () => {
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@a', search);

    mention.update();
    await vi.advanceTimersByTimeAsync(300);

    expect(mention.open.value).toBe(true);
    expect(mention.loading.value).toBe(false);
    expect(mention.items.value).toEqual([{ path: 'src/a.ts', name: 'a.ts' }]);
  });
});
