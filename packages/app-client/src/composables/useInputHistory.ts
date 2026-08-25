// packages/app-client/src/composables/useInputHistory.ts
// Shell-style ↑/↓ recall of previously sent messages, scoped per session.
//
// `ArrowUp` on an EMPTY draft steps back through older entries sent in the
// current session; `ArrowDown` walks forward again and ultimately restores
// the draft the user had before they started browsing. A draft with ANY
// content (whitespace included) keeps the arrows for plain caret movement —
// recall never hijacks them. And once browsing, the arrows walk history
// freely even though the recalled text now fills the composer: "empty"
// alone can't carry the walk, the browsing cursor (historyIndex) does.
// Any manual edit drops out of browsing mode (see `resetBrowsing`, called
// from the composer's input handler).
//
// The history is persisted to localStorage as a `Record<sessionId, string[]>`.
// A draft session (no id yet — the empty-session composer before its first
// message is sent) does NOT record history: that first message is submitted
// before the session exists, so it is intentionally dropped rather than
// attributed to the wrong session.
//
// The composer keeps the keydown orchestration (which also juggles the slash
// and mention menus); this composable owns only the history map, the browsing
// cursor, and the caret/selection work needed to apply a recalled entry.

import { computed, nextTick, ref, watch, type Ref } from 'vue';
import { STORAGE_KEYS, safeGetJson, safeSetJson } from '@moonshot-ai/app-core/lib';
import type { TextFieldLike } from '@moonshot-ai/app-composer';

/** Cap each session's persisted history so storage can't grow without bound. */
const MAX_HISTORY = 100;

export interface InputHistoryDeps {
  /** The live composer text — recalled entries overwrite it. */
  text: Ref<string>;
  /** The editing surface, used to move the selection on a recall. */
  editorRef: Ref<TextFieldLike | null>;
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
  const { text, editorRef, sessionId } = deps;

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

  // The draft counts as "empty" only at zero characters — whitespace and
  // newlines are content and keep the arrows for caret movement. (Pills need
  // no special case: mention/attachment/quote atoms serialize into `text`,
  // so a pill-only draft is non-empty too.)
  function isEmpty(): boolean {
    return text.value.length === 0;
  }

  /** The ArrowUp gate, single-sourced for both composer mirrors: history
   *  exists AND (the draft is empty OR a walk is already in progress — the
   *  recalled text fills the composer, so "empty" alone can't carry it). */
  function canRecallOlder(): boolean {
    return currentList.value.length > 0 && (historyIndex !== -1 || isEmpty());
  }

  function applyHistoryText(value: string): void {
    text.value = value;
    void nextTick(() => {
      const el = editorRef.value;
      if (!el) return;
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
  // But FIRST walk home: the pre-browse draft (draftBeforeHistory) only lives
  // here — a bare cursor drop would strand it, and the outgoing session would
  // persist the RECALLED text as its draft. (The composer's draft persistence
  // saves the outgoing session's text on the same trigger; restoring here keeps
  // it correct regardless of watcher order.)
  watch(sessionId, () => {
    if (historyIndex !== -1) {
      historyIndex = -1;
      applyHistoryText(draftBeforeHistory);
    }
  });

  return {
    push,
    canRecallOlder,
    recallOlder,
    recallNewer,
    resetBrowsing,
    isBrowsing,
    hasHistory,
  };
}
