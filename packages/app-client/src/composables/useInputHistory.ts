
import { computed, nextTick, ref, watch, type Ref } from 'vue';
import { STORAGE_KEYS, safeGetJson, safeSetJson } from '@moonshot-ai/app-core/lib';
import type { TextFieldLike } from '@moonshot-ai/app-composer/runtime';
import { composerSnapshotDocument, docToText, parseComposerSnapshot, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { getDraftPromotion } from '../client/draftPromotion';

const MAX_HISTORY = 100;
const MAX_HISTORY_BYTES = 1024 * 1024;

export interface InputHistoryDeps {
  text: Ref<string>;
  editorRef: Ref<TextFieldLike | null>;
  sessionId: () => string | undefined;
  hasAttachments?: () => boolean;
  getSnapshot?: () => ComposerDocumentSnapshot | undefined;
  onRecall?: (text: string, snapshot: ComposerDocumentSnapshot | undefined, sessionId: string | undefined) => void;
}

type InputHistoryEntry = string | { text: string; snapshot: ComposerDocumentSnapshot };

function parseEntry(value: unknown): InputHistoryEntry | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { text?: unknown; snapshot?: unknown };
  if (typeof record.text !== 'string') return null;
  const snapshot = parseComposerSnapshot(record.snapshot);
  return snapshot === null ? (record.text.length > 0 ? record.text : null) : { text: record.text, snapshot };
}

function boundedHistory(map: Record<string, InputHistoryEntry[]>): Record<string, InputHistoryEntry[]> {
  let remaining = MAX_HISTORY_BYTES - 4;
  const result: Record<string, InputHistoryEntry[]> = {};
  for (const [sid, entries] of Object.entries(map).reverse()) {
    const cost = JSON.stringify(sid).length * 2 + 8;
    if (cost > remaining) continue;
    let budget = remaining - cost;
    const kept: InputHistoryEntry[] = [];
    for (const entry of entries.slice(-MAX_HISTORY).reverse()) {
      const bytes = JSON.stringify(entry).length * 2 + 2;
      if (bytes > budget) continue;
      kept.unshift(entry);
      budget -= bytes;
    }
    if (kept.length > 0) { result[sid] = kept; remaining = budget; }
  }
  return Object.fromEntries(Object.entries(result).reverse());
}

function loadMap(sessionId: string | undefined): Record<string, InputHistoryEntry[]> {
  const raw = safeGetJson<unknown>(STORAGE_KEYS.inputHistory);
  if (Array.isArray(raw)) {
    const list = raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (!sessionId || list.length === 0) return {};
    const capped = list.length > MAX_HISTORY ? list.slice(-MAX_HISTORY) : list;
    const map = { [sessionId]: capped };
    safeSetJson(STORAGE_KEYS.inputHistory, map);
    return map;
  }
  if (raw && typeof raw === 'object') {
    return Object.fromEntries(Object.entries(raw).flatMap(([sid, entries]) => Array.isArray(entries)
      ? [[sid, entries.flatMap((entry: unknown) => parseEntry(entry) ?? []).slice(-MAX_HISTORY)]]
      : []));
  }
  return {};
}

function appendEntry(list: InputHistoryEntry[], entry: InputHistoryEntry): InputHistoryEntry[] {
  if (JSON.stringify(list.at(-1)) === JSON.stringify(entry)) return list;
  const next = [...list, entry];
  return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
}

let draftEntries: InputHistoryEntry[] = [];

export function settleDraftInputHistory(activeSessionId: string | undefined): void {
  if (!activeSessionId || draftEntries.length === 0) return;
  const entries = draftEntries;
  draftEntries = [];
  if (getDraftPromotion()?.sessionId !== activeSessionId) return;
  const { [activeSessionId]: previous = [], ...others } = loadMap(activeSessionId);
  safeSetJson(STORAGE_KEYS.inputHistory, boundedHistory({ ...others, [activeSessionId]: entries.reduce(appendEntry, previous) }));
}

export function forgetInputHistory(sid: string): void {
  const map = loadMap(sid);
  if (!(sid in map)) return;
  const { [sid]: _dropped, ...rest } = map;
  safeSetJson(STORAGE_KEYS.inputHistory, rest);
}

export function useInputHistory(deps: InputHistoryDeps) {
  const { text, editorRef, sessionId } = deps;

  const historyMap = ref<Record<string, InputHistoryEntry[]>>(boundedHistory(loadMap(sessionId())));
  const currentList = computed(() => historyMap.value[sessionId() ?? ''] ?? []);
  let historyIndex = -1;
  let draftBeforeHistory: InputHistoryEntry = '';
  let browsingSessionId: string | undefined;
  let recallRevision = 0;

  function push(entry: string, snapshot?: ComposerDocumentSnapshot): void {
    const sid = sessionId();
    resetBrowsing();
    const trimmed = entry.trim();
    if (!trimmed && (snapshot?.attachmentOrder.length ?? 0) === 0) return;
    const compact = snapshot === undefined ? undefined : { ...snapshot, attachments: snapshot.attachments.map(entry => {
      const { previewUrl: _preview, thumbnailUrl: _thumbnail, ...rest } = entry;
      return rest;
    }) };
    const parsed = compact === undefined ? null : parseComposerSnapshot(compact);
    const stored: InputHistoryEntry = parsed === null ? trimmed : { text: trimmed, snapshot: parsed };
    if (!sid) {
      draftEntries = appendEntry(draftEntries, stored);
      return;
    }
    const persisted = loadMap(sid);
    const list = persisted[sid] ?? historyMap.value[sid] ?? [];
    const next = appendEntry(list, stored);
    if (next === list) return;
    const { [sid]: _previous, ...others } = persisted;
    historyMap.value = boundedHistory({ ...others, [sid]: next });
    safeSetJson(STORAGE_KEYS.inputHistory, historyMap.value);
  }

  function isEmpty(): boolean {
    return text.value.length === 0 && deps.hasAttachments?.() !== true;
  }

  function canRecallOlder(): boolean {
    return currentList.value.length > 0 && (historyIndex !== -1 || isEmpty());
  }

  function applyHistoryText(entry: InputHistoryEntry, ownerSessionId = sessionId()): void {
    const snapshot = typeof entry === 'string' ? undefined : parseComposerSnapshot(entry.snapshot) ?? undefined;
    const value = snapshot === undefined ? (typeof entry === 'string' ? entry : entry.text) : docToText(composerSnapshotDocument(snapshot));
    const revision = ++recallRevision;
    const sid = sessionId();
    text.value = value;
    if (browsingSessionId !== ownerSessionId) return;
    deps.onRecall?.(value, snapshot, ownerSessionId);
    void nextTick(() => {
      if (revision !== recallRevision || sid !== sessionId() || ownerSessionId !== sid) return;
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
      if (deps.hasAttachments?.() === true) return;
      const snapshot = deps.getSnapshot?.();
      const parsed = snapshot === undefined ? null : parseComposerSnapshot(snapshot);
      draftBeforeHistory = parsed === null ? text.value : { text: text.value, snapshot: parsed };
      browsingSessionId = sessionId();
      historyIndex = list.length - 1;
    } else if (historyIndex > 0) {
      historyIndex -= 1;
    } else {
      return;
    }
    applyHistoryText(list[historyIndex]!);
  }

  function recallNewer(): void {
    if (historyIndex === -1) return;
    const list = currentList.value;
    if (browsingSessionId === sessionId() && historyIndex < list.length - 1) {
      historyIndex += 1;
      applyHistoryText(list[historyIndex]!);
    } else {
      restoreDraft();
    }
  }

  function restoreDraft(ownerSessionId = sessionId()): void {
    if (historyIndex === -1) return;
    historyIndex = -1;
    applyHistoryText(draftBeforeHistory, ownerSessionId);
  }

  function resetBrowsing(): void {
    historyIndex = -1;
    recallRevision += 1;
  }

  function isBrowsing(): boolean {
    return historyIndex !== -1;
  }

  function hasHistory(): boolean {
    return currentList.value.length > 0;
  }

  watch(sessionId, (sid, previous) => {
    if (!previous && sid) historyMap.value = boundedHistory(loadMap(sid));
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
    restoreDraft,
    resetBrowsing,
    isBrowsing,
    hasHistory,
  };
}
