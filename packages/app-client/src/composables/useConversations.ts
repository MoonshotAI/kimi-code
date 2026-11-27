import { ref, shallowReactive, type Ref } from 'vue';
import type { KimiEventConnection, KimiWebApi } from '@moonshot-ai/app-core/api';
import {
  applyConversationFrame,
  EMPTY_CONVERSATION,
  mergeLatestPage,
  prependOlderPage,
  type ConversationFrame,
  type ConversationItem,
  type ConversationLoadError,
  type ConversationNotice,
  type ConversationTurn,
  type ConversationView,
} from '@moonshot-ai/app-core/conversation';

const OLDER_PAGE_SIZE = 20;

export interface ConversationEntry {
  readonly sessionId: string;
  readonly agentId: string;
  readonly version: Ref<number>;
  view: ConversationView;
  latestPages: number;
  loaded: boolean;
  loadError?: ConversationLoadError;
  loadingOlder: boolean;
  loadOlderError: boolean;
  holders: number;
  lastTouched: number;
}

export interface ConversationPoolListener {
  onPage?(entry: ConversationEntry, previous: readonly ConversationTurn[], initial: boolean): void;
  onTurnStarted?(entry: ConversationEntry, turn: ConversationTurn): void;
  onTurnEnded?(entry: ConversationEntry, turn: ConversationTurn): void;
  onTurnsRemoved?(entry: ConversationEntry, turnIds: readonly string[]): void;
  onItem?(entry: ConversationEntry, item: ConversationItem): void;
  onChange?(entry: ConversationEntry): void;
  onNotice?(entry: ConversationEntry, notice: ConversationNotice): void;
  onLoadFailed?(entry: ConversationEntry, error: ConversationLoadError): void;
}

export interface ConversationPool {
  readonly entries: ReadonlyMap<string, ConversationEntry>;
  getEntry(sessionId: string, agentId: string): ConversationEntry | undefined;
  entriesOf(sessionId: string): ConversationEntry[];
  activate(sessionId: string, agentId: string): ConversationEntry;
  prefetch(sessionId: string, agentId: string): ConversationEntry;
  deactivate(sessionId: string, agentId: string): void;
  release(sessionId: string, agentId: string): void;
  handleFrame(sessionId: string, agentId: string, frame: ConversationFrame): void;
  failSession(sessionId: string, error: ConversationLoadError): void;
  loadOlder(entry: ConversationEntry): Promise<void>;
  trim(): void;
  forget(sessionId: string): void;
  whenLoaded(entry: ConversationEntry): Promise<void>;
}

export function createConversationPool(deps: {
  api: () => KimiWebApi;
  connection: () => KimiEventConnection | null;
  maxParked: number;
  retain?: (entry: ConversationEntry) => boolean;
  listener?: ConversationPoolListener;
  onEvicted?: (entry: ConversationEntry) => void;
}): ConversationPool {
  const entries = shallowReactive(new Map<string, ConversationEntry>());
  const loadWaiters = new Map<ConversationEntry, Array<() => void>>();
  const dirty = new Set<ConversationEntry>();
  let touchSeq = 0;
  let frameHandle: number | null = null;
  let taskHandle: ReturnType<typeof setTimeout> | null = null;

  function keyOf(sessionId: string, agentId: string): string {
    return `${sessionId}\0${agentId}`;
  }

  function clearScheduledFlush(): void {
    if (frameHandle !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameHandle);
    if (taskHandle !== null) clearTimeout(taskHandle);
    frameHandle = null;
    taskHandle = null;
  }

  function flush(): void {
    clearScheduledFlush();
    for (const entry of dirty) entry.version.value += 1;
    dirty.clear();
  }

  function commit(entry: ConversationEntry): void {
    dirty.delete(entry);
    if (dirty.size === 0) clearScheduledFlush();
    entry.version.value += 1;
    deps.listener?.onChange?.(entry);
  }

  function markDirty(entry: ConversationEntry): void {
    dirty.add(entry);
    deps.listener?.onChange?.(entry);
    if (frameHandle !== null || taskHandle !== null) return;
    if (typeof requestAnimationFrame === 'function') frameHandle = requestAnimationFrame(flush);
    taskHandle = setTimeout(flush, 50);
  }

  function ensure(sessionId: string, agentId: string): ConversationEntry {
    const key = keyOf(sessionId, agentId);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        sessionId,
        agentId,
        version: ref(0),
        view: EMPTY_CONVERSATION,
        latestPages: 0,
        loaded: false,
        loadingOlder: false,
        loadOlderError: false,
        holders: 0,
        lastTouched: 0,
      };
      entries.set(key, entry);
      deps.connection()?.subscribeConversation(sessionId, agentId);
    }
    touchSeq += 1;
    entry.lastTouched = touchSeq;
    return entry;
  }

  function drop(entry: ConversationEntry): void {
    entries.delete(keyOf(entry.sessionId, entry.agentId));
    dirty.delete(entry);
    for (const resolve of loadWaiters.get(entry) ?? []) resolve();
    loadWaiters.delete(entry);
    deps.connection()?.unsubscribeConversation(entry.sessionId, [entry.agentId]);
  }

  function trim(): void {
    const parked = [...entries.values()]
      .filter((entry) => entry.holders === 0 && deps.retain?.(entry) !== true)
      .sort((a, b) => b.lastTouched - a.lastTouched);
    for (const entry of parked.slice(deps.maxParked)) {
      drop(entry);
      deps.onEvicted?.(entry);
    }
  }

  function settleWaiters(entry: ConversationEntry): void {
    for (const resolve of loadWaiters.get(entry) ?? []) resolve();
    loadWaiters.delete(entry);
  }

  function receivePage(entry: ConversationEntry, page: Extract<ConversationFrame, { type: 'turns' }>): void {
    const previous = entry.view.turns;
    const initial = !entry.loaded;
    entry.view = mergeLatestPage(entry.view, page);
    entry.latestPages += 1;
    entry.loaded = true;
    entry.loadError = undefined;
    deps.listener?.onPage?.(entry, previous, initial);
    commit(entry);
    settleWaiters(entry);
  }

  function failEntry(entry: ConversationEntry, error: ConversationLoadError): void {
    const first = entry.loadError === undefined;
    entry.loadError = { code: error.code, msg: error.msg };
    commit(entry);
    settleWaiters(entry);
    if (first) deps.listener?.onLoadFailed?.(entry, entry.loadError);
  }

  function handleFrame(sessionId: string, agentId: string, frame: ConversationFrame): void {
    const entry = entries.get(keyOf(sessionId, agentId));
    if (entry === undefined) return;
    if (frame.type === 'turns') {
      receivePage(entry, frame);
      return;
    }
    if (frame.type === 'turns.failed') {
      failEntry(entry, frame);
      return;
    }
    if (frame.type === 'notice') {
      deps.listener?.onNotice?.(entry, frame);
      return;
    }
    if (!entry.loaded) return;
    entry.view = applyConversationFrame(entry.view, frame);
    markDirty(entry);
    const listener = deps.listener;
    if (listener === undefined) return;
    if (frame.type === 'item.started' || frame.type === 'item.ended') {
      listener.onItem?.(entry, frame.item);
      return;
    }
    if (frame.type === 'turns.removed') {
      listener.onTurnsRemoved?.(entry, frame.turn_ids);
      return;
    }
    if (frame.type !== 'turn.started' && frame.type !== 'turn.ended') return;
    const turn = entry.view.turns.find((candidate) => candidate.turn_id === frame.turn.turn_id);
    if (turn === undefined) return;
    if (frame.type === 'turn.started') listener.onTurnStarted?.(entry, turn);
    else listener.onTurnEnded?.(entry, turn);
  }

  async function loadOlder(entry: ConversationEntry): Promise<void> {
    if (entry.loadingOlder || !entry.view.hasMore) return;
    const beforeOrdinal = entry.view.turns[0]?.ordinal;
    const latestPages = entry.latestPages;
    const beforeCount = entry.view.turns.length;
    entry.loadingOlder = true;
    entry.loadOlderError = false;
    commit(entry);
    try {
      const page = await deps.api().getAgentTurns(entry.sessionId, entry.agentId, { beforeOrdinal, pageSize: OLDER_PAGE_SIZE });
      if (entries.get(keyOf(entry.sessionId, entry.agentId)) !== entry || entry.latestPages !== latestPages) return;
      entry.view = prependOlderPage(entry.view, page);
      if (entry.view.hasMore && entry.view.turns.length === beforeCount) entry.loadOlderError = true;
    } catch {
      entry.loadOlderError = true;
    } finally {
      entry.loadingOlder = false;
      if (entries.get(keyOf(entry.sessionId, entry.agentId)) === entry) commit(entry);
    }
  }

  return {
    entries,
    getEntry: (sessionId, agentId) => entries.get(keyOf(sessionId, agentId)),
    entriesOf: (sessionId) => [...entries.values()].filter((entry) => entry.sessionId === sessionId),
    activate(sessionId, agentId) {
      const entry = ensure(sessionId, agentId);
      entry.holders += 1;
      trim();
      return entry;
    },
    prefetch(sessionId, agentId) {
      const entry = ensure(sessionId, agentId);
      trim();
      return entry;
    },
    deactivate(sessionId, agentId) {
      const entry = entries.get(keyOf(sessionId, agentId));
      if (entry === undefined) return;
      entry.holders = Math.max(0, entry.holders - 1);
      trim();
    },
    release(sessionId, agentId) {
      const entry = entries.get(keyOf(sessionId, agentId));
      if (entry === undefined) return;
      entry.holders = Math.max(0, entry.holders - 1);
      if (entry.holders === 0) drop(entry);
    },
    handleFrame,
    failSession(sessionId, error) {
      for (const entry of entries.values()) {
        if (entry.sessionId === sessionId) failEntry(entry, error);
      }
    },
    loadOlder,
    trim,
    forget(sessionId) {
      for (const entry of entries.values()) {
        if (entry.sessionId === sessionId) drop(entry);
      }
    },
    whenLoaded(entry) {
      if (entry.loaded || entry.loadError !== undefined || entries.get(keyOf(entry.sessionId, entry.agentId)) !== entry) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const waiters = loadWaiters.get(entry) ?? [];
        waiters.push(resolve);
        loadWaiters.set(entry, waiters);
      });
    },
  };
}
