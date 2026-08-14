// packages/app-client/src/composables/useMentionMenu.ts
import { nextTick, ref, type Ref } from 'vue';
import type { FileItem } from '@moonshot-ai/app-core/client';
import type { TextFieldLike } from '../lib/textField';

export interface MentionMenuDeps {
  /** The live composer text — the @token is read from it and rewritten on select. */
  text: Ref<string>;
  /** The editing surface, used to read the caret and place it after insertion. */
  editorRef: Ref<TextFieldLike | null>;
  /** File search for the @-query (getter; undefined disables the menu). */
  searchFiles: () => ((q: string) => Promise<FileItem[]>) | undefined;
}

interface MentionToken {
  token: string;
  start: number;
  end: number;
}

/**
 * `@` file-mention menu: token detection, debounced search, keyboard navigation
 * state, and insertion.
 *
 * The composer keeps the keydown orchestration (arrow keys, Enter/Tab, Escape)
 * because it also juggles the slash menu and history recall; this composable
 * owns the menu's open/items/active/loading state and the search/insert logic.
 */
export function useMentionMenu(deps: MentionMenuDeps) {
  const { text, editorRef, searchFiles } = deps;

  const open = ref(false);
  const items = ref<FileItem[]>([]);
  const active = ref(0);
  const loading = ref(false);

  // Debounce timer for the search.
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Find the @token under the cursor in the current text value. Returns null if none. */
  function getMentionToken(): MentionToken | null {
    const val = text.value;
    const pos = editorRef.value?.selectionStart ?? val.length;
    // Walk backwards from the cursor to find the start of a @token.
    let start = pos - 1;
    while (start >= 0 && !/\s/.test(val[start]!)) {
      start--;
    }
    start++;
    const tokenPart = val.slice(start, pos);
    if (!tokenPart.startsWith('@')) return null;
    // The end of the token is where the cursor is (or after the next space).
    return { token: tokenPart.slice(1), start, end: pos };
  }

  function update(): void {
    const mt = getMentionToken();
    const search = searchFiles();
    if (timer !== null) clearTimeout(timer);
    // No @token (or only a bare `@` with nothing to search yet) — stay closed.
    if (!mt || !search || mt.token.length === 0) {
      open.value = false;
      loading.value = false;
      return;
    }
    const token = mt.token;
    timer = setTimeout(async () => {
      loading.value = true;
      open.value = true;
      active.value = 0;
      // Apply the response only while it still matches the live @token.
      const stillCurrent = () => {
        const live = getMentionToken();
        return live !== null && live.token === token && open.value;
      };
      try {
        const results = await search(token);
        if (stillCurrent()) items.value = results;
      } catch {
        if (stillCurrent()) items.value = [];
      } finally {
        if (stillCurrent()) loading.value = false;
      }
    }, 200);
  }

  /** Close the menu and cancel any pending debounced search. Without the
      cancel, a timer started just before the close (blur, session switch,
      submit, Escape) would fire afterwards and reopen the menu. An already
      in-flight search needs no cancel — its stillCurrent() guard sees
      open.value === false and applies nothing. */
  function close(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    open.value = false;
    loading.value = false;
  }

  function select(item: FileItem): void {
    const mt = getMentionToken();
    if (!mt) return;
    const val = text.value;
    // Replace the @query token with the file path.
    text.value = val.slice(0, mt.start) + item.path + val.slice(mt.end);
    open.value = false;
    void nextTick(() => {
      const el = editorRef.value;
      if (!el) return;
      const newPos = mt.start + item.path.length;
      el.setSelectionRange(newPos, newPos);
      el.focus();
    });
  }

  return { open, items, active, loading, update, close, select };
}
