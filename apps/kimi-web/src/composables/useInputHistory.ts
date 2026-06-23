// apps/kimi-web/src/composables/useInputHistory.ts
import { nextTick, ref, type Ref } from 'vue';
import { STORAGE_KEYS, safeGetJson, safeSetJson } from '../lib/storage';

/** Cap the persisted history so storage can't grow without bound. */
const MAX_HISTORY = 200;

function loadHistory(): string[] {
  const stored = safeGetJson<unknown>(STORAGE_KEYS.inputHistory);
  if (!Array.isArray(stored)) return [];
  return stored.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

export interface InputHistoryDeps {
  /** The live composer text — recalled entries overwrite it. */
  text: Ref<string>;
  /** The textarea element, used to read the caret and move the selection. */
  textareaRef: Ref<HTMLTextAreaElement | null>;
  /** Re-fit the textarea after its text changes. */
  autosize: () => void;
}

/**
 * Shell-style ↑/↓ recall of previously sent messages.
 *
 * `ArrowUp` on the first line steps back through older entries; `ArrowDown`
 * walks forward again and ultimately restores the draft the user had before
 * they started browsing. Any manual edit drops out of browsing mode (see
 * `resetBrowsing`, called from the composer's input handler).
 *
 * The history is persisted to localStorage (one global list). The composer has
 * two mutually-exclusive instances — the empty-session composer and the docked
 * composer — and the first message of a new session is sent by the empty
 * composer, which unmounts as soon as the first turn appears. Persisting (and
 * re-reading on mount) is what lets the docked composer recall that first
 * message instead of starting from an empty list. A single global list also
 * sidesteps the fact that a new session has no id until after the first submit.
 *
 * The composer keeps the keydown orchestration (which also juggles the slash
 * and mention menus); this composable owns only the history list, the browsing
 * cursor, and the textarea caret/selection work needed to apply a recalled
 * entry.
 */
export function useInputHistory(deps: InputHistoryDeps) {
  const { text, textareaRef, autosize } = deps;

  const inputHistory = ref(loadHistory());
  // -1 = browsing nothing (live draft). Otherwise an index into inputHistory.
  let historyIndex = -1;
  let draftBeforeHistory = '';

  function push(entry: string): void {
    const trimmed = entry.trim();
    historyIndex = -1;
    if (!trimmed) return;
    // Skip consecutive duplicates so repeated sends don't pad the history.
    if (inputHistory.value.at(-1) === trimmed) return;
    const next = [...inputHistory.value, trimmed];
    inputHistory.value = next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    safeSetJson(STORAGE_KEYS.inputHistory, inputHistory.value);
  }

  function caretAtFirstLine(): boolean {
    const el = textareaRef.value;
    if (!el) return false;
    const pos = el.selectionStart ?? 0;
    // No newline before the caret → it sits on the first visual line.
    return el.value.lastIndexOf('\n', pos - 1) === -1;
  }

  function applyHistoryText(value: string): void {
    text.value = value;
    void nextTick(() => {
      const el = textareaRef.value;
      if (!el) return;
      autosize();
      const pos = value.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function recallOlder(): void {
    if (inputHistory.value.length === 0) return;
    if (historyIndex === -1) {
      draftBeforeHistory = text.value;
      historyIndex = inputHistory.value.length - 1;
    } else if (historyIndex > 0) {
      historyIndex -= 1;
    } else {
      return; // already at the oldest entry
    }
    applyHistoryText(inputHistory.value[historyIndex]!);
  }

  function recallNewer(): void {
    if (historyIndex === -1) return;
    if (historyIndex < inputHistory.value.length - 1) {
      historyIndex += 1;
      applyHistoryText(inputHistory.value[historyIndex]!);
    } else {
      historyIndex = -1;
      applyHistoryText(draftBeforeHistory);
    }
  }

  function resetBrowsing(): void {
    historyIndex = -1;
  }

  function isBrowsing(): boolean {
    return historyIndex !== -1;
  }

  function hasHistory(): boolean {
    return inputHistory.value.length > 0;
  }

  return {
    push,
    caretAtFirstLine,
    recallOlder,
    recallNewer,
    resetBrowsing,
    isBrowsing,
    hasHistory,
  };
}
