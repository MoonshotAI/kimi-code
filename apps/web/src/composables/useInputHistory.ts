// apps/kimi-web/src/composables/useInputHistory.ts
// Shell-style ↑/↓ recall of previously sent messages, scoped per session.
//
// `ArrowUp` at the very start of the text steps back through older entries
// sent in the current session; `ArrowDown` walks forward again and ultimately
// restores the draft the user had before they started browsing. Any manual edit
// drops out of browsing mode (see `resetBrowsing`, called from the composer's
// input handler).
//
// The history is persisted to localStorage as a `Record<sessionId, string[]>`.
// A draft session (no id yet — the empty-session composer before its first
// message is sent) does NOT record history: that first message is submitted
// before the session exists, so it is intentionally dropped rather than
// attributed to the wrong session.
//
// The composer keeps the keydown orchestration (which also juggles the slash
// and mention menus); this composable owns only the history map, the browsing
// cursor, and the textarea caret/selection work needed to apply a recalled
// entry.

import { computed, nextTick, ref, watch, type Ref } from 'vue';
import { STORAGE_KEYS, safeGetJson, safeSetJson } from '../lib/storage';

/** Cap each session's persisted history so storage can't grow without bound. */
const MAX_HISTORY = 100;

export interface InputHistoryDeps {
  /** The live composer text — recalled entries overwrite it. */
  text: Ref<string>;
  /** The textarea element, used to read the caret and move the selection. */
  textareaRef: Ref<HTMLTextAreaElement | null>;
  /** Re-fit the textarea after its text changes. */
  autosize: () => void;
  /** Active session id — scopes the recalled history (getter for reactivity). */
  sessionId: () => string | undefined;
}

/**
 * Read the persisted history map, migrating the legacy global `string[]` format
 * (pre per-session) into the current session on first sight. Migration is
 * one-shot: once a sessioned map is written, the array branch never runs again.
 */
function loadMap(sessionId: string | undefined): Record<string, string[]> {
  const raw = safeGetJson<unknown>(STORAGE_KEYS.inputHistory);
  if (Array.isArray(raw)) {
    const list = raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
    // No session yet (empty-session composer): leave the legacy value in place
    // so a later docked mount — which has a session id — can migrate it.
    if (!sessionId || list.length === 0) return {};
    const capped = list.length > MAX_HISTORY ? list.slice(-MAX_HISTORY) : list;
    const map = { [sessionId]: capped };
    safeSetJson(STORAGE_KEYS.inputHistory, map);
    return map;
  }
  if (raw && typeof raw === 'object') {
    return raw as Record<string, string[]>;
  }
  return {};
}

export function useInputHistory(deps: InputHistoryDeps) {
  const { text, textareaRef, autosize, sessionId } = deps;

  const historyMap = ref<Record<string, string[]>>(loadMap(sessionId()));
  const currentList = computed(() => historyMap.value[sessionId() ?? ''] ?? []);
  // -1 = browsing nothing (live draft). Otherwise an index into currentList.
  let historyIndex = -1;
  let draftBeforeHistory = '';

  function push(entry: string): void {
    const sid = sessionId();
    historyIndex = -1;
    // Draft sessions have no id yet — drop the entry (see file header).
    if (!sid) return;
    const trimmed = entry.trim();
    if (!trimmed) return;
    const list = historyMap.value[sid] ?? [];
    // Skip consecutive duplicates so repeated sends don't pad the history.
    if (list.at(-1) === trimmed) return;
    const next = [...list, trimmed];
    const capped = next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    historyMap.value = { ...historyMap.value, [sid]: capped };
    safeSetJson(STORAGE_KEYS.inputHistory, historyMap.value);
  }

  function caretAtTextStart(): boolean {
    const el = textareaRef.value;
    if (!el) return false;
    // Only recall when the caret sits at the very start of the text. Otherwise
    // ArrowUp while navigating a multi-line draft would hijack the caret and
    // jump to a previous message instead of moving within the draft.
    return (el.selectionStart ?? 0) === 0;
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
    const list = currentList.value;
    if (list.length === 0) return;
    if (historyIndex === -1) {
      draftBeforeHistory = text.value;
      historyIndex = list.length - 1;
    } else if (historyIndex > 0) {
      historyIndex -= 1;
    } else {
      return; // already at the oldest entry
    }
    applyHistoryText(list[historyIndex]!);
  }

  function recallNewer(): void {
    if (historyIndex === -1) return;
    const list = currentList.value;
    if (historyIndex < list.length - 1) {
      historyIndex += 1;
      applyHistoryText(list[historyIndex]!);
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
    return currentList.value.length > 0;
  }

  // Switching sessions: drop the browsing cursor so a recall in the new session
  // starts from its own latest entry, not wherever the previous session left off.
  watch(sessionId, () => {
    historyIndex = -1;
  });

  return {
    push,
    caretAtTextStart,
    recallOlder,
    recallNewer,
    resetBrowsing,
    isBrowsing,
    hasHistory,
  };
}
