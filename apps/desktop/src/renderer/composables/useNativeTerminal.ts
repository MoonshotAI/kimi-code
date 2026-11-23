import {
  normalizeTerminalSshTarget,
  type NativeTerminalSshTarget,
  type TerminalActivity,
} from '../../shared/terminal-activity';

import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue';
import { reorderedPanelTabs } from '@moonshot-ai/app-client/lib';
import { hostsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { markTerminalInstanceMoving } from './terminalInstances';

export type { NativeTerminalSshTarget };

export interface NativeTerminalTab {
  id: string;
  shell: string;
  binary?: string;
  cwd: string;
  ssh?: NativeTerminalSshTarget;
  status: 'running' | 'exited';
  exitCode: number | null;
}

export interface NativeTerminalBridge {
  inspectNativeTerminals?: (ids: string[]) => Promise<TerminalActivity[]>;
  createNativeTerminal: (opts?: {
    cwd?: string;
    cols?: number;
    rows?: number;
    ssh?: NativeTerminalSshTarget;
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

export const MAX_TERMINAL_SESSIONS = 10;

const DRAFT_KEY = '__draft__';

export function nativeTerminalDraftKey(workspaceId: string | null): string {
  return `${DRAFT_KEY}:${workspaceId ?? 'none'}`;
}

interface SessionBucket {
  key: string;
  tabs: NativeTerminalTab[];
  panelTabs: NativeTerminalTab[];
  activeTabId: string | null;
  open: boolean;
  inflight: Promise<unknown> | null;
  panelInflight: Promise<unknown> | null;
  lastUsed: number;
  mergedInto?: SessionBucket;
}

export interface NativeTerminalStore {
  inspect: (ids: string[]) => Promise<TerminalActivity[]>;
  available: boolean;
  currentKey: Ref<string>;
  bucketsWithTabs: ComputedRef<SessionBucket[]>;
  tabs: ComputedRef<NativeTerminalTab[]>;
  allTabs: ComputedRef<NativeTerminalTab[]>;
  activeTabId: ComputedRef<string | null>;
  open: ComputedRef<boolean>;
  error: Ref<string | null>;
  switchSession: (key: string | null) => void;
  migrateDraftTo: (fromKey: string, toKey: string) => void;
  destroySession: (key: string) => void;
  toggle: (cwd?: string) => void;
  openPanel: (cwd?: string) => void;
  closePanel: () => void;
  ensureTab: (cwd?: string) => void;
  newTab: (cwd?: string, size?: { cols?: number; rows?: number }) => Promise<NativeTerminalTab | null>;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  moveTab: (id: string, index: number) => void;
  moveTabToPanel: (id: string) => NativeTerminalTab | null;
  moveTabToBottom: (id: string, index: number) => NativeTerminalTab | null;
  restartTab: (id: string, size?: { cols?: number; rows?: number }) => Promise<void>;
  newPanelTab: (
    cwd?: string,
    size?: { cols?: number; rows?: number },
    options?: { stillValid?: () => boolean },
  ) => Promise<{ tab: NativeTerminalTab | null; error: string | null }>;
  closePanelTab: (id: string) => void;
  panelTabOf: (id: string) => NativeTerminalTab | undefined;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  onOutput: (id: string, cb: (data: string, truncated?: boolean) => void) => () => void;
  onExit: (id: string, cb: (exitCode: number | null) => void) => () => void;
}

export function createNativeTerminalStore(
  bridge: NativeTerminalBridge | undefined,
  resolveSsh: () => Promise<NativeTerminalSshTarget | undefined> | NativeTerminalSshTarget | undefined = () =>
    undefined,
): NativeTerminalStore {
  const usable = canUseNativeTerminal(bridge);
  const buckets = reactive(new Map<string, SessionBucket>());
  const currentKey = ref(DRAFT_KEY);
  const error = ref<string | null>(null);
  let lruClock = 0;

  function makeBucket(key: string): SessionBucket {
    return reactive({
      key,
      tabs: [],
      panelTabs: [],
      activeTabId: null,
      open: false,
      inflight: null,
      panelInflight: null,
      lastUsed: 0,
    });
  }
  buckets.set(DRAFT_KEY, makeBucket(DRAFT_KEY));

  function currentBucket(): SessionBucket {
    let bucket = buckets.get(currentKey.value);
    if (bucket === undefined) {
      bucket = makeBucket(currentKey.value);
      lruClock += 1;
      bucket.lastUsed = lruClock;
      buckets.set(bucket.key, bucket);
      evictIfNeeded();
    }
    return bucket;
  }

  function evictIfNeeded(): void {
    const live = [...buckets.values()].filter(
      (bucket) =>
        bucket.tabs.length > 0 ||
        bucket.panelTabs.length > 0 ||
        bucket.inflight !== null ||
        bucket.panelInflight !== null,
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

  function peekBucket(): SessionBucket | undefined {
    return buckets.get(currentKey.value);
  }

  const allTabs = computed(() => [...buckets.values()].flatMap(bucket => [...bucket.tabs, ...bucket.panelTabs]));
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

  const outputHandlers = new Map<string, Set<(data: string) => void>>();
  const exitHandlers = new Map<string, Set<(exitCode: number | null) => void>>();
  const pendingOutput = new Map<string, { chunks: string[]; size: number; truncated: boolean }>();
  const MAX_PENDING_SIZE = 256 * 1024;
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
      const tab =
        bucket.tabs.find((item) => item.id === id) ??
        bucket.panelTabs.find((item) => item.id === id);
      if (tab !== undefined) {
        tab.status = 'exited';
        tab.exitCode = exitCode;
        return;
      }
    }
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
        pending = { chunks: [], size: 0, truncated: false };
        pendingOutput.set(id, pending);
      }
      pending.chunks.push(data);
      pending.size += data.length;
      while (pending.chunks.length > MAX_PENDING_CHUNKS || pending.size > MAX_PENDING_SIZE) {
        const first = pending.chunks[0]!;
        const excess = pending.size - MAX_PENDING_SIZE;
        if (pending.chunks.length <= MAX_PENDING_CHUNKS && first.length > excess) {
          pending.chunks[0] = first.slice(excess);
          pending.size -= excess;
        } else {
          pending.chunks.shift();
          pending.size -= first.length;
        }
        pending.truncated = true;
      }
    });
    bridge.onNativeTerminalExit((id, exitCode) => {
      markExited(id, exitCode);
      const handlers = exitHandlers.get(id);
      if (handlers !== undefined) {
        for (const handler of handlers) handler(exitCode);
      }
    });
  }

  function destroyBucket(bucket: SessionBucket): void {
    for (const tab of [...bucket.tabs, ...bucket.panelTabs]) {
      bridge?.closeNativeTerminal(tab.id);
      dropTabRouting(tab.id);
    }
    bucket.tabs = [];
    bucket.panelTabs = [];
    bucket.activeTabId = null;
    buckets.delete(bucket.key);
  }

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

  function migrateDraftTo(fromKey: string, toKey: string): void {
    const draft = buckets.get(fromKey);
    if (draft === undefined) return;
    if (
      draft.tabs.length === 0 &&
      draft.panelTabs.length === 0 &&
      !draft.open &&
      draft.inflight === null &&
      draft.panelInflight === null
    ) return;
    const target = buckets.get(toKey);
    if (target !== undefined) {
      draft.tabs.unshift(...target.tabs);
      draft.panelTabs.unshift(...target.panelTabs);
      draft.activeTabId = target.activeTabId ?? draft.activeTabId;
      draft.open = target.open || draft.open;
      adoptInflightInto(draft, 'inflight', [draft.inflight, target.inflight]);
      adoptInflightInto(draft, 'panelInflight', [draft.panelInflight, target.panelInflight]);
      target.mergedInto = draft;
    }
    buckets.delete(fromKey);
    draft.key = toKey;
    buckets.set(toKey, draft);
  }

  function destroySession(key: string): void {
    const bucket = buckets.get(key);
    if (bucket !== undefined) {
      destroyBucket(bucket);
    }
  }

  function adoptInflightInto(
    bucket: SessionBucket,
    slot: 'inflight' | 'panelInflight',
    promises: Array<Promise<unknown> | null>,
  ): void {
    const live = promises.filter((p): p is Promise<unknown> => p !== null);
    if (live.length === 0) return;
    const guard = Promise.allSettled(live);
    bucket[slot] = guard;
    void guard.finally(() => {
      if (bucket[slot] === guard) bucket[slot] = null;
    });
  }

  function toRunningTab(
    info: { id: string; shell: string; cwd: string },
    ssh: NativeTerminalSshTarget | undefined,
  ): NativeTerminalTab {
    return {
      id: info.id,
      shell: info.shell,
      cwd: info.cwd,
      ...(ssh !== undefined ? { ssh } : {}),
      status: 'running',
      exitCode: null,
    };
  }

  async function newTabInto(
    bucket: SessionBucket,
    list: 'tabs' | 'panelTabs',
    cwd?: string,
    size?: { cols?: number; rows?: number },
    reportError: (message: string | null) => void = (message) => {
      error.value = message;
    },
    stillValid: () => boolean = () => true,
  ): Promise<NativeTerminalTab | null> {
    if (!usable || bridge === undefined) return null;
    reportError(null);
    try {
      const resolved = resolveSsh();
      const ssh = resolved instanceof Promise ? await resolved : resolved;
      const info = await bridge.createNativeTerminal({
        cwd,
        cols: size?.cols,
        rows: size?.rows,
        ...(ssh !== undefined ? { ssh } : {}),
      });
      if (!stillValid()) {
        bridge.closeNativeTerminal(info.id);
        dropTabRouting(info.id);
        return null;
      }
      const home = resolveHome(bucket);
      if (home === undefined) {
        bridge.closeNativeTerminal(info.id);
        dropTabRouting(info.id);
        return null;
      }
      const tab = toRunningTab(info, ssh);
      home[list].push(tab);
      if (list === 'tabs') home.activeTabId = tab.id;
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
      reportError(createError instanceof Error ? createError.message : String(createError));
      return null;
    }
  }

  function newTab(cwd?: string, size?: { cols?: number; rows?: number }): Promise<NativeTerminalTab | null> {
    return newTabInto(currentBucket(), 'tabs', cwd, size);
  }

  async function newPanelTab(
    cwd?: string,
    size?: { cols?: number; rows?: number },
    options?: { stillValid?: () => boolean },
  ): Promise<{ tab: NativeTerminalTab | null; error: string | null }> {
    let spawnError: string | null = null;
    const bucket = currentBucket();
    const promise = newTabInto(bucket, 'panelTabs', cwd, size, (message) => {
      spawnError = message;
    }, options?.stillValid);
    adoptInflightInto(bucket, 'panelInflight', [bucket.panelInflight, promise]);
    const tab = await promise;
    return { tab, error: spawnError };
  }

  function ensureTab(cwd?: string): void {
    const bucket = currentBucket();
    if (bucket.tabs.length > 0 || bucket.inflight !== null) return;
    const promise = newTabInto(bucket, 'tabs', cwd);
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

  function moveTab(id: string, index: number): void {
    const bucket = currentBucket();
    const next = reorderedPanelTabs(bucket.tabs, id, index);
    if (next !== null) bucket.tabs = next;
  }

  function moveTabToPanel(id: string): NativeTerminalTab | null {
    const bucket = currentBucket();
    const index = bucket.tabs.findIndex((item) => item.id === id);
    const tab = bucket.tabs[index];
    if (tab === undefined) return null;
    markTerminalInstanceMoving(id);
    bucket.tabs.splice(index, 1);
    bucket.panelTabs.push(tab);
    if (bucket.activeTabId === id) {
      bucket.activeTabId = bucket.tabs[Math.min(index, bucket.tabs.length - 1)]?.id ?? null;
    }
    if (bucket.tabs.length === 0) bucket.open = false;
    return tab;
  }

  function moveTabToBottom(id: string, index: number): NativeTerminalTab | null {
    for (const source of buckets.values()) {
      const from = source.panelTabs.findIndex((item) => item.id === id);
      const tab = source.panelTabs[from];
      if (tab === undefined) continue;
      markTerminalInstanceMoving(id);
      source.panelTabs.splice(from, 1);
      const bucket = currentBucket();
      bucket.tabs.splice(Math.max(0, Math.min(bucket.tabs.length, index)), 0, tab);
      bucket.activeTabId = id;
      bucket.open = true;
      return tab;
    }
    return null;
  }

  function closePanelTab(id: string): void {
    for (const bucket of buckets.values()) {
      const index = bucket.panelTabs.findIndex((item) => item.id === id);
      if (index === -1) continue;
      bucket.panelTabs.splice(index, 1);
      bridge?.closeNativeTerminal(id);
      dropTabRouting(id);
      return;
    }
  }

  function panelTabOf(id: string): NativeTerminalTab | undefined {
    for (const bucket of buckets.values()) {
      const tab = bucket.panelTabs.find((item) => item.id === id);
      if (tab !== undefined) return tab;
    }
    return undefined;
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
      const resolved = existing.ssh ?? resolveSsh();
      const ssh = resolved instanceof Promise ? await resolved : resolved;
      const info = await bridge.createNativeTerminal({
        cwd,
        cols: size?.cols,
        rows: size?.rows,
        ...(ssh !== undefined ? { ssh } : {}),
      });
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
      const tab = toRunningTab(info, ssh);
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
      const tab =
        bucket.tabs.find((item) => item.id === id) ??
        bucket.panelTabs.find((item) => item.id === id);
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

  function onOutput(id: string, cb: (data: string, truncated?: boolean) => void): () => void {
    let handlers = outputHandlers.get(id);
    if (handlers === undefined) {
      handlers = new Set();
      outputHandlers.set(id, handlers);
    }
    handlers.add(cb);
    const pending = pendingOutput.get(id);
    if (pending !== undefined) {
      pendingOutput.delete(id);
      if (pending.truncated) cb('', true);
      for (const chunk of pending.chunks) cb(chunk);
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
    inspect: async ids => {
      if (bridge?.inspectNativeTerminals) {
        const activities = await bridge.inspectNativeTerminals(ids);
        for (const activity of activities) {
          const tab = findTab(activity.id);
          if (tab && activity.state !== 'unknown') tab.binary = activity.binary || tab.shell;
        }
        return activities;
      }
      return ids.map(id => ({ id, state: 'unknown', binary: findTab(id)?.shell ?? '', cwd: findTab(id)?.cwd ?? '', processes: [] }));
    },
    allTabs,
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
    moveTab,
    moveTabToPanel,
    moveTabToBottom,
    restartTab,
    newPanelTab,
    closePanelTab,
    panelTabOf,
    write,
    resize,
    onOutput,
    onExit,
  };
}

function toSshTarget(hostId: string, host: { host: string; identityFile?: string } | undefined): NativeTerminalSshTarget {
  const target = normalizeTerminalSshTarget(host);
  if (target === undefined) throw new Error(`SSH host "${hostId}" is not configured`);
  return target;
}

function activeWorkspaceSshTarget():
  | Promise<NativeTerminalSshTarget | undefined>
  | NativeTerminalSshTarget
  | undefined {
  const hostId = workspacesStore().visibleWorkspace?.hostId;
  if (hostId === undefined) return undefined;
  const store = hostsStore();
  const host = store.hostFor(hostId);
  if (host !== undefined || store.loaded) return toSshTarget(hostId, host);
  return store.load().then(() => toSshTarget(hostId, store.hostFor(hostId)));
}

let store: NativeTerminalStore | null = null;

export function useNativeTerminal(): NativeTerminalStore {
  if (store === null) {
    store = createNativeTerminalStore(
      typeof window === 'undefined' ? undefined : (window as { kimiDesktop?: NativeTerminalBridge }).kimiDesktop,
      activeWorkspaceSshTarget,
    );
  }
  return store;
}
