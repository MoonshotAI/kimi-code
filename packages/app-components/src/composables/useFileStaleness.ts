
import { computed, reactive, ref, watch, type Ref } from 'vue';
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import { completedEditToolIds, editedFileMarkers, isStaleSince, runningEditToolIds } from '../lib/fileStaleness';
import { normalizePathKey } from '../chatTurnRendering';

export interface FileStalenessTracker {
  stale: Ref<boolean>;
  markLoaded: (markersOverride?: ReadonlyMap<string, string>) => void;
}

const historyToolKeys = reactive(new Set<string>());
const seenRunningToolIds = reactive(new Set<string>());
const latestMarkers = reactive(new Map<string, string>());
const savedSnapshots = new Map<string, { keys: string[]; snapshot: Map<string, string | undefined> }>();
let lastSessionId: string | null = null;

export function useFileStaleness(opts: { turns: Ref<ChatTurn[]>; sessionId: Ref<string | null>; cwd: Ref<string> }) {
  let lastHeadTurnId: string | null = opts.turns.value[0]?.id ?? null;
  let sessionStartedAt = Date.now();

  function syncSession(): void {
    if (opts.sessionId.value === lastSessionId) return;
    lastSessionId = opts.sessionId.value;
    sessionStartedAt = Date.now();
    historyToolKeys.clear();
    seenRunningToolIds.clear();
    latestMarkers.clear();
    savedSnapshots.clear();
    lastHeadTurnId = opts.turns.value[0]?.id ?? null;
  }

  watch(opts.sessionId, syncSession);
  syncSession();

  function isLiveBaselineTurn(turn: ChatTurn): boolean {
    if (turn.endedAt !== undefined && Date.parse(turn.endedAt) >= sessionStartedAt) return true;
    return turn.createdAt !== undefined && Date.parse(turn.createdAt) >= sessionStartedAt;
  }

  function markHistoryTools(turn: ChatTurn): void {
    if (isLiveBaselineTurn(turn)) return;
    for (const toolId of completedEditToolIds(turn)) {
      if (seenRunningToolIds.has(`${turn.id}:${toolId}`)) continue;
      historyToolKeys.add(`${turn.id}:${toolId}`);
    }
  }

  watch(
    () => opts.turns.value,
    (list) => {
      for (const t of list) {
        for (const toolId of runningEditToolIds(t)) {
          seenRunningToolIds.add(`${t.id}:${toolId}`);
        }
      }
      const headId = list[0]?.id ?? null;
      if (headId !== lastHeadTurnId) {
        const prevHeadIndex = list.findIndex((t) => t.id === lastHeadTurnId);
        if (prevHeadIndex > 0) {
          for (const t of list.slice(0, prevHeadIndex)) markHistoryTools(t);
        } else if (lastHeadTurnId === null && headId !== null) {
          for (const t of list) markHistoryTools(t);
        }
        lastHeadTurnId = headId;
      }
    },
  );

  watch(
    () =>
      editedFileMarkers(opts.turns.value, opts.cwd.value, (turnId, toolId) =>
        historyToolKeys.has(`${turnId}:${toolId}`),
      ),
    (fresh) => {
      for (const [k, v] of fresh) latestMarkers.set(k, v);
    },
    { immediate: true },
  );

  const markers = computed(() => new Map(latestMarkers));

  function createTracker(id: string, paths: () => (string | null | undefined)[]): FileStalenessTracker {
    const saved = savedSnapshots.get(id);
    const stale = ref(false);
    let keys: string[] = saved?.keys ?? [];
    let snapshot = saved?.snapshot ?? new Map<string, string | undefined>();
    if (saved) stale.value = isStaleSince(markers.value, snapshot, keys);

    function keySet(): string[] {
      const out = new Set<string>();
      for (const p of paths()) {
        if (p) out.add(normalizePathKey(p));
      }
      return [...out];
    }

    function markLoaded(markersOverride?: ReadonlyMap<string, string>): void {
      const source = markersOverride ?? markers.value;
      keys = keySet();
      snapshot = new Map(keys.map((k) => [k, source.get(k)]));
      savedSnapshots.set(id, { keys, snapshot });
      stale.value = isStaleSince(markers.value, snapshot, keys);
    }

    watch(markers, () => {
      stale.value = isStaleSince(markers.value, snapshot, keys);
    });

    return { stale, markLoaded };
  }

  return { markers, createTracker };
}
