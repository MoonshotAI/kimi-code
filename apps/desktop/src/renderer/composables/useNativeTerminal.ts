// apps/desktop/src/renderer/composables/useNativeTerminal.ts
// Desktop-only native terminal store (design: docs/plans/2026-07-27-desktop-native-terminal.md).
// Module singleton; no bridge (web/tests) → inert no-op.

import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue';

export interface NativeTerminalTab {
  id: string;
  /** Shell basename reported by the main process (display label). */
  shell: string;
  cwd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
}

/** Subset of the preload `kimiDesktop` bridge this store needs. */
export interface NativeTerminalBridge {
  createNativeTerminal: (opts?: {
    cwd?: string;
    cols?: number;
    rows?: number;
  }) => Promise<{ id: string; shell: string; cwd: string }>;
  nativeTerminalInput: (id: string, data: string) => void;
  nativeTerminalResize: (id: string, cols: number, rows: number) => void;
  closeNativeTerminal: (id: string) => void;
  onNativeTerminalOutput: (cb: (id: string, data: string) => void) => () => void;
  onNativeTerminalExit: (cb: (id: string, exitCode: number | null) => void) => () => void;
}

export function canUseNativeTerminal(bridge: NativeTerminalBridge | undefined): boolean {
  return (
    bridge !== undefined &&
    typeof bridge.createNativeTerminal === 'function' &&
    typeof bridge.onNativeTerminalOutput === 'function' &&
    typeof bridge.onNativeTerminalExit === 'function'
  );
}

/** Sessions with live terminals kept at once; evicting the oldest kills its
 *  PTYs (idle shells are cheap, but unbounded ones are not). */
export const MAX_TERMINAL_SESSIONS = 10;

/** Bucket key when no session is selected (new-chat draft). */
const DRAFT_KEY = '__draft__';

/** Bucket key of a workspace's no-session draft (single source — App.vue's
 *  session bucketing and the WS deletion cleanup both key off this). */
export function nativeTerminalDraftKey(workspaceId: string | null): string {
  return `${DRAFT_KEY}:${workspaceId ?? 'none'}`;
}

interface SessionBucket {
  key: string;
  tabs: NativeTerminalTab[];
  activeTabId: string | null;
  open: boolean;
  /** First-tab creation dedup (per bucket). */
  inflight: Promise<unknown> | null;
  /** LRU clock: bumped on every switch-to. */
  lastUsed: number;
  /** Set when this object was dropped by a MERGE: points at the survivor so
   *  its in-flight creates can follow. Never set on eviction/destruction —
   *  those must not let a stale create land in a later same-key bucket. */
  mergedInto?: SessionBucket;
}

export interface NativeTerminalStore {
  /** True when the main-process bridge exists (desktop); false = every
   *  method is an inert no-op and the UI should hide its entry points. */
  available: boolean;
  /** Key of the session whose bucket is currently displayed. */
  currentKey: Ref<string>;
  /** Buckets that own tabs (the panel renders all of them to keep the xterm
   *  instances alive; only the current one is visible). */
  bucketsWithTabs: ComputedRef<SessionBucket[]>;
  tabs: ComputedRef<NativeTerminalTab[]>;
  activeTabId: ComputedRef<string | null>;
  open: ComputedRef<boolean>;
  /** Last create failure, surfaced in the panel (cleared on next create). */
  error: Ref<string | null>;
  /** Swap the displayed bucket (called from App.vue on session change; the
   *  caller computes the key — drafts are keyed per workspace). */
  switchSession: (key: string | null) => void;
  /** Move the bucket at fromKey to toKey when the draft becomes a session
   *  (re-key — in-flight creates stay attached). */
  migrateDraftTo: (fromKey: string, toKey: string) => void;
  /** Kill a session's terminals for good (archive / workspace delete). */
  destroySession: (key: string) => void;
  toggle: (cwd?: string) => void;
  openPanel: (cwd?: string) => void;
  closePanel: () => void;
  /** Spawn the first tab iff none exists and none is being created (deduped). */
  ensureTab: (cwd?: string) => void;
  newTab: (cwd?: string, size?: { cols?: number; rows?: number }) => Promise<NativeTerminalTab | null>;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  restartTab: (id: string, size?: { cols?: number; rows?: number }) => Promise<void>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  onOutput: (id: string, cb: (data: string) => void) => () => void;
  onExit: (id: string, cb: (exitCode: number | null) => void) => () => void;
}

export function createNativeTerminalStore(bridge: NativeTerminalBridge | undefined): NativeTerminalStore {
  const usable = canUseNativeTerminal(bridge);
  const buckets = reactive(new Map<string, SessionBucket>());
  const currentKey = ref(DRAFT_KEY);
  const error = ref<string | null>(null);
  let lruClock = 0;

  function makeBucket(key: string): SessionBucket {
    return reactive({
      key,
      tabs: [],
      activeTabId: null,
      open: false,
      inflight: null,
      lastUsed: 0,
    });
  }
  // The draft bucket always exists so the panel works with no session.
  buckets.set(DRAFT_KEY, makeBucket(DRAFT_KEY));

  function currentBucket(): SessionBucket {
    // Lazy: buckets come to exist only for sessions that USE the terminal.
    let bucket = buckets.get(currentKey.value);
    if (bucket === undefined) {
      bucket = makeBucket(currentKey.value);
      // Creation IS the first use (switchSession only stamps existing buckets).
      lruClock += 1;
      bucket.lastUsed = lruClock;
      buckets.set(bucket.key, bucket);
      evictIfNeeded();
    }
    return bucket;
  }

  function evictIfNeeded(): void {
    // The cap counts sessions with LIVE terminals only — empty buckets (the
    // permanent draft, or one whose tabs all closed) cost nothing.
    const live = [...buckets.values()].filter(
      (bucket) => bucket.tabs.length > 0 || bucket.inflight !== null,
    );
    if (live.length <= MAX_TERMINAL_SESSIONS) return;
    let oldest: SessionBucket | null = null;
    for (const bucket of live) {
      if (bucket.key === currentKey.value) continue;
      if (oldest === null || bucket.lastUsed < oldest.lastUsed) {
        oldest = bucket;
      }
    }
    if (oldest !== null) {
      destroyBucket(oldest);
    }
  }

  /** Side-effect-free read (getters/watchers must never create buckets —
   *  merely browsing sessions would otherwise fill the LRU map). */
  function peekBucket(): SessionBucket | undefined {
    return buckets.get(currentKey.value);
  }

  const tabs = computed(() => peekBucket()?.tabs ?? []);
  const activeTabId = computed({
    get: () => peekBucket()?.activeTabId ?? null,
    set: (value: string | null) => {
      currentBucket().activeTabId = value;
    },
  });
  const open = computed({
    get: () => peekBucket()?.open ?? false,
    set: (value: boolean) => {
      currentBucket().open = value;
    },
  });
  const bucketsWithTabs = computed(() => [...buckets.values()].filter((bucket) => bucket.tabs.length > 0));

  // Tab-id keyed routing (ids are unique across sessions).
  const outputHandlers = new Map<string, Set<(data: string) => void>>();
  const exitHandlers = new Map<string, Set<(exitCode: number | null) => void>>();
  const pendingOutput = new Map<string, string[]>();
  const MAX_PENDING_CHUNKS = 1000;
  const pendingExits = new Map<string, number | null>();

  function dropTabRouting(id: string): void {
    outputHandlers.delete(id);
    exitHandlers.delete(id);
    pendingOutput.delete(id);
    pendingExits.delete(id);
  }

  function markExited(id: string, exitCode: number | null): void {
    for (const bucket of buckets.values()) {
      const tab = bucket.tabs.find((item) => item.id === id);
      if (tab !== undefined) {
        tab.status = 'exited';
        tab.exitCode = exitCode;
        return;
      }
    }
    // Exit can beat the create response — park it and apply on push.
    pendingExits.set(id, exitCode);
  }

  if (usable && bridge !== undefined) {
    bridge.onNativeTerminalOutput((id, data) => {
      const handlers = outputHandlers.get(id);
      if (handlers !== undefined && handlers.size > 0) {
        for (const handler of handlers) handler(data);
        return;
      }
      let pending = pendingOutput.get(id);
      if (pending === undefined) {
        pending = [];
        pendingOutput.set(id, pending);
      }
      if (pending.length < MAX_PENDING_CHUNKS) pending.push(data);
    });
    bridge.onNativeTerminalExit((id, exitCode) => {
      markExited(id, exitCode);
      const handlers = exitHandlers.get(id);
      if (handlers !== undefined) {
        for (const handler of handlers) handler(exitCode);
      }
    });
  }

  /** Kill every tab in a bucket (eviction / future cleanup entry points). */
  function destroyBucket(bucket: SessionBucket): void {
    for (const tab of bucket.tabs) {
      bridge?.closeNativeTerminal(tab.id);
      dropTabRouting(tab.id);
    }
    bucket.tabs = [];
    bucket.activeTabId = null;
    buckets.delete(bucket.key);
  }

  // Where a captured bucket's late create may land: still-registered or
  // merge-forwarded — never a later bucket recreated under the same key.
  function resolveHome(bucket: SessionBucket): SessionBucket | undefined {
    let home: SessionBucket | undefined = bucket;
    while (home !== undefined && buckets.get(home.key) !== home) {
      home = home.mergedInto;
    }
    return home;
  }

  function switchSession(key: string | null): void {
    currentKey.value = key ?? DRAFT_KEY;
    const bucket = buckets.get(currentKey.value);
    if (bucket !== undefined) {
      lruClock += 1;
      bucket.lastUsed = lruClock;
    }
  }

  /** The draft became a session: re-key its bucket; an existing target is
   *  absorbed (the draft object survives so in-flight creates land). */
  function migrateDraftTo(fromKey: string, toKey: string): void {
    const draft = buckets.get(fromKey);
    if (draft === undefined) return;
    if (draft.tabs.length === 0 && !draft.open && draft.inflight === null) return;
    const target = buckets.get(toKey);
    if (target !== undefined) {
      // The target's tabs lead (seen last in this session); the draft's follow.
      draft.tabs.unshift(...target.tabs);
      draft.activeTabId = target.activeTabId ?? draft.activeTabId;
      draft.open = target.open || draft.open;
      adoptInflight(draft, [draft.inflight, target.inflight]);
      target.mergedInto = draft;
    }
    buckets.delete(fromKey);
    draft.key = toKey;
    buckets.set(toKey, draft);
  }

  /** Archive/delete path: kill the session's terminals for good. */
  function destroySession(key: string): void {
    const bucket = buckets.get(key);
    if (bucket !== undefined) {
      destroyBucket(bucket);
    }
  }

  // Re-arm the first-tab dedup guard over EVERY inherited in-flight create.
  function adoptInflight(bucket: SessionBucket, promises: Array<Promise<unknown> | null>): void {
    const live = promises.filter((p): p is Promise<unknown> => p !== null);
    if (live.length === 0) return;
    const guard = Promise.allSettled(live);
    bucket.inflight = guard;
    void guard.finally(() => {
      if (bucket.inflight === guard) bucket.inflight = null;
    });
  }

  async function newTabInto(
    bucket: SessionBucket,
    cwd?: string,
    size?: { cols?: number; rows?: number },
  ): Promise<NativeTerminalTab | null> {
    if (!usable || bridge === undefined) return null;
    error.value = null;
    try {
      const info = await bridge.createNativeTerminal({ cwd, cols: size?.cols, rows: size?.rows });
      // Land only where the captured bucket still lives — an evicted/destroyed
      // one kills the PTY, even if a new bucket owns its key.
      const home = resolveHome(bucket);
      if (home === undefined) {
        bridge.closeNativeTerminal(info.id);
        // Its buffered events go with the dead PTY, not a future tab's replay.
        dropTabRouting(info.id);
        return null;
      }
      const tab: NativeTerminalTab = {
        id: info.id,
        shell: info.shell,
        cwd: info.cwd,
        status: 'running',
        exitCode: null,
      };
      home.tabs.push(tab);
      home.activeTabId = tab.id;
      // A landing tab makes the bucket live — restamp and re-check the cap.
      lruClock += 1;
      home.lastUsed = lruClock;
      evictIfNeeded();
      if (pendingExits.has(tab.id)) {
        tab.status = 'exited';
        tab.exitCode = pendingExits.get(tab.id) ?? null;
        pendingExits.delete(tab.id);
      }
      return tab;
    } catch (createError) {
      error.value = createError instanceof Error ? createError.message : String(createError);
      return null;
    }
  }

  function newTab(cwd?: string, size?: { cols?: number; rows?: number }): Promise<NativeTerminalTab | null> {
    return newTabInto(currentBucket(), cwd, size);
  }

  /** Spawn the first tab iff none exists and none is being created. */
  function ensureTab(cwd?: string): void {
    const bucket = currentBucket();
    if (bucket.tabs.length > 0 || bucket.inflight !== null) return;
    // Capture THIS promise: a newer create must not be cleared by the stale
    // one's finally.
    const promise = newTabInto(bucket, cwd);
    bucket.inflight = promise;
    void promise.finally(() => {
      if (bucket.inflight === promise) {
        bucket.inflight = null;
      }
    });
  }

  function toggle(cwd?: string): void {
    open.value = !open.value;
    if (open.value) {
      ensureTab(cwd);
    }
  }

  function openPanel(cwd?: string): void {
    if (open.value) return;
    toggle(cwd);
  }

  function closePanel(): void {
    if (open.value) {
      open.value = false;
    }
  }

  function closeTab(id: string): void {
    const bucket = currentBucket();
    const index = bucket.tabs.findIndex((item) => item.id === id);
    if (index === -1) return;
    const [removed] = bucket.tabs.splice(index, 1);
    if (removed === undefined) return;
    bridge?.closeNativeTerminal(removed.id);
    dropTabRouting(removed.id);
    if (bucket.activeTabId === id) {
      const next = bucket.tabs[Math.min(index, bucket.tabs.length - 1)];
      bucket.activeTabId = next !== undefined ? next.id : null;
    }
  }

  function activateTab(id: string): void {
    if (currentBucket().tabs.some((item) => item.id === id)) {
      activeTabId.value = id;
    }
  }

  async function restartTab(id: string, size?: { cols?: number; rows?: number }): Promise<void> {
    const bucket = currentBucket();
    const index = bucket.tabs.findIndex((item) => item.id === id);
    if (index === -1 || !usable || bridge === undefined) return;
    const existing = bucket.tabs[index];
    if (existing === undefined) return;
    const cwd = existing.cwd;
    error.value = null;
    try {
      // Create the replacement FIRST — a failed spawn must not strand the
      // panel with the old tab already gone.
      const info = await bridge.createNativeTerminal({ cwd, cols: size?.cols, rows: size?.rows });
      // The await gave the world time to change: the bucket may be gone (or
      // merge-forwarded), and the restart target may have closed — kill the
      // replacement either way.
      const home = resolveHome(bucket);
      if (home === undefined) {
        bridge.closeNativeTerminal(info.id);
        dropTabRouting(info.id);
        return;
      }
      const currentIndex = home.tabs.findIndex((item) => item.id === id);
      if (currentIndex === -1) {
        bridge.closeNativeTerminal(info.id);
        dropTabRouting(info.id);
        return;
      }
      bridge.closeNativeTerminal(id);
      home.tabs.splice(currentIndex, 1);
      dropTabRouting(id);
      const tab: NativeTerminalTab = {
        id: info.id,
        shell: info.shell,
        cwd: info.cwd,
        status: 'running',
        exitCode: null,
      };
      // Keep the tab's position in the strip.
      home.tabs.splice(Math.min(currentIndex, home.tabs.length), 0, tab);
      home.activeTabId = tab.id;
      if (pendingExits.has(tab.id)) {
        tab.status = 'exited';
        tab.exitCode = pendingExits.get(tab.id) ?? null;
        pendingExits.delete(tab.id);
      }
    } catch (createError) {
      error.value = createError instanceof Error ? createError.message : String(createError);
    }
  }

  function findTab(id: string): NativeTerminalTab | undefined {
    for (const bucket of buckets.values()) {
      const tab = bucket.tabs.find((item) => item.id === id);
      if (tab !== undefined) return tab;
    }
    return undefined;
  }

  function write(id: string, data: string): void {
    const tab = findTab(id);
    if (tab === undefined || tab.status !== 'running') return;
    bridge?.nativeTerminalInput(id, data);
  }

  function resize(id: string, cols: number, rows: number): void {
    const tab = findTab(id);
    if (tab === undefined || tab.status !== 'running') return;
    bridge?.nativeTerminalResize(id, cols, rows);
  }

  function onOutput(id: string, cb: (data: string) => void): () => void {
    let handlers = outputHandlers.get(id);
    if (handlers === undefined) {
      handlers = new Set();
      outputHandlers.set(id, handlers);
    }
    handlers.add(cb);
    // Replay anything the shell printed before this subscription existed.
    const pending = pendingOutput.get(id);
    if (pending !== undefined) {
      pendingOutput.delete(id);
      for (const chunk of pending) cb(chunk);
    }
    return () => handlers.delete(cb);
  }

  function onExit(id: string, cb: (exitCode: number | null) => void): () => void {
    let handlers = exitHandlers.get(id);
    if (handlers === undefined) {
      handlers = new Set();
      exitHandlers.set(id, handlers);
    }
    handlers.add(cb);
    return () => handlers.delete(cb);
  }

  return {
    available: usable,
    currentKey,
    bucketsWithTabs,
    tabs,
    activeTabId,
    open,
    error,
    switchSession,
    migrateDraftTo,
    destroySession,
    toggle,
    openPanel,
    closePanel,
    ensureTab,
    newTab,
    closeTab,
    activateTab,
    restartTab,
    write,
    resize,
    onOutput,
    onExit,
  };
}

// Singleton: one store per app — the bridge subscriptions live for the app's
// lifetime (the panel, the ⌃` dispatcher and the View menu action all share).
let store: NativeTerminalStore | null = null;

export function useNativeTerminal(): NativeTerminalStore {
  if (store === null) {
    store = createNativeTerminalStore(
      (window as { kimiDesktop?: NativeTerminalBridge }).kimiDesktop,
    );
  }
  return store;
}
