import { panelRegistry, type PanelTabType } from './panelRegistry';

export interface StoredPanelTab {
  type: PanelTabType;
  payload?: unknown;
}

export interface StoredPanelSnapshot {
  workspaceId?: string | null;
  tabs: StoredPanelTab[];
  activeIndex: number | null;
  visible: boolean;
  expanded: boolean;
}

export type PanelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const PREFIX = 'kimi-web.panel-tabs.v1:';
const GLOBAL_STORAGE_LIMIT = 1024 * 1024;
const SNAPSHOT_COUNT_LIMIT = 100;
const destroyedListeners = new Set<(key: string) => void>();

export function onPanelContextDestroyed(listener: (key: string) => void): () => void {
  destroyedListeners.add(listener);
  return () => { destroyedListeners.delete(listener); };
}

export function destroyPanelContext(key: string): void {
  try { defaultPanelStorage()?.removeItem(PREFIX + key); } catch {}
  for (const listener of destroyedListeners) listener(key);
}

const workspaceDestroyedListeners = new Set<(workspaceId: string) => void>();

export function onPanelWorkspaceDestroyed(listener: (workspaceId: string) => void): () => void {
  workspaceDestroyedListeners.add(listener);
  return () => { workspaceDestroyedListeners.delete(listener); };
}

export function panelContextsOfWorkspace(storage: PanelStorage | undefined, workspaceId: string): string[] {
  if (!storage) return [];
  try {
    return storedEntries(storage, '').flatMap(entry => {
      try {
        const value: unknown = JSON.parse(storage.getItem(entry.key) ?? 'null');
        return object(value) && value['workspaceId'] === workspaceId ? [entry.key.slice(PREFIX.length)] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

export function destroyPanelWorkspace(workspaceId: string): void {
  for (const key of panelContextsOfWorkspace(defaultPanelStorage(), workspaceId)) destroyPanelContext(key);
  destroyPanelContext(`__draft__:${workspaceId}`);
  for (const listener of workspaceDestroyedListeners) listener(workspaceId);
}

function storedEntries(storage: PanelStorage, except: string): Array<{ key: string; size: number; savedAt: number }> {
  const entries: Array<{ key: string; size: number; savedAt: number }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || key === except || !key.startsWith(PREFIX)) continue;
    const raw = storage.getItem(key) ?? '';
    let savedAt = 0;
    try {
      const value: unknown = JSON.parse(raw);
      if (object(value) && typeof value['savedAt'] === 'number') savedAt = value['savedAt'];
    } catch {}
    entries.push({ key, size: key.length + raw.length, savedAt });
  }
  return entries.sort((a, b) => a.savedAt - b.savedAt);
}

const INLINE_CONTENT_LIMIT = 64 * 1024;
const INLINE_SNAPSHOT_LIMIT = 256 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(type: PanelTabType, value: unknown): Record<string, unknown> | null {
  if (!object(value)) return null;
  const string = (key: string): boolean => typeof value[key] === 'string';
  switch (type) {
    case 'diff': return {};
    case 'files': return {};
    case 'inspector': return {};
    case 'context': return {};
    case 'browser': return string('browserId') && /^[A-Za-z0-9:_-]{1,128}$/.test(value['browserId'] as string) ? { browserId: value['browserId'], ...(string('title') ? { title: (value['title'] as string).slice(0, 512) } : {}), ...(string('customTitle') ? { customTitle: (value['customTitle'] as string).slice(0, 512) } : {}) } : null;
    case 'file':
      return string('path') && (value['content'] === undefined || string('content')) &&
        (value['line'] === undefined || Number.isSafeInteger(value['line'])) ? value : null;
    case 'agent': return string('sessionId') && string('subagentId') ? value : null;
    case 'btw': return string('parentId') && string('agentId') && Number.isSafeInteger(value['seq']) && (value['seq'] as number) > 0 ? value : null;
    case 'compaction': return string('turnId') && (value['text'] === undefined || string('text')) ? value : null;
    case 'term': return { ...(string('title') ? { title: value['title'] } : {}), ...(string('cwd') ? { cwd: value['cwd'] } : {}) };
    case 'turn-diff': {
      const change = value['change'];
      return string('turnId') && object(change) && typeof change['path'] === 'string' &&
        typeof change['added'] === 'number' && Number.isFinite(change['added']) &&
        typeof change['removed'] === 'number' && Number.isFinite(change['removed']) &&
        (value['sessionId'] === undefined || string('sessionId')) &&
        (value['cwd'] === undefined || string('cwd')) &&
        (value['daemonTurnId'] === undefined || Number.isSafeInteger(value['daemonTurnId'])) ? value : null;
    }
  }
}

export function defaultPanelStorage(): PanelStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function readPanelSnapshot(storage: PanelStorage | undefined, key: string): StoredPanelSnapshot | undefined {
  try {
    const raw = storage?.getItem(PREFIX + key);
    if (!raw) return undefined;
    const data: unknown = JSON.parse(raw);
    if (!object(data) || !Array.isArray(data['tabs']) || typeof data['visible'] !== 'boolean') return undefined;
    const tabs: StoredPanelTab[] = [];
    let activeIndex: number | null = null;
    for (const [index, item] of data['tabs'].entries()) {
      if (!object(item) || typeof item['type'] !== 'string' || !Object.hasOwn(panelRegistry, item['type'])) continue;
      const type = item['type'] as PanelTabType;
      const payload = payloadOf(type, item['payload']);
      if (payload === null) continue;
      if (index === data['activeIndex']) activeIndex = tabs.length;
      tabs.push({ type, payload });
    }
    return { ...(typeof data['workspaceId'] === 'string' ? { workspaceId: data['workspaceId'] } : {}), tabs, activeIndex, visible: data['visible'], expanded: data['expanded'] === true };
  } catch { return undefined; }
}

function withoutInlineContent(tab: StoredPanelTab): StoredPanelTab {
  if (!object(tab.payload)) return tab;
  const field = tab.type === 'file' ? 'content' : tab.type === 'compaction' ? 'text' : undefined;
  if (field === undefined) return tab;
  const payload = { ...tab.payload };
  delete payload[field];
  return { type: tab.type, payload };
}

export function writePanelSnapshot(storage: PanelStorage | undefined, key: string, snapshot: StoredPanelSnapshot): void {
  if (!storage) return;
  const storageKey = PREFIX + key;
  try {
    if (snapshot.tabs.length === 0 && !snapshot.visible) { storage.removeItem(storageKey); return; }
    let inlineBudget = INLINE_SNAPSHOT_LIMIT;
    const tabs = snapshot.tabs.map(tab => {
      const payload = payloadOf(tab.type, tab.payload ?? {});
      const stored = { type: tab.type, payload };
      const field = tab.type === 'file' ? 'content' : tab.type === 'compaction' ? 'text' : undefined;
      const content = field === undefined ? undefined : payload?.[field];
      if (typeof content !== 'string') return stored;
      const length = content.length;
      if (length > INLINE_CONTENT_LIMIT || length > inlineBudget) return withoutInlineContent(stored);
      inlineBudget -= length;
      return stored;
    });
    const entries = storedEntries(storage, storageKey);
    const encode = (items: StoredPanelTab[]): string => JSON.stringify({ ...snapshot, tabs: items, savedAt: Date.now() });
    let raw = encode(tabs);
    if (raw.length + storageKey.length > GLOBAL_STORAGE_LIMIT) raw = encode(tabs.map(withoutInlineContent));
    if (raw.length + storageKey.length > GLOBAL_STORAGE_LIMIT) { storage.removeItem(storageKey); return; }
    let total = entries.reduce((sum, entry) => sum + entry.size, raw.length + storageKey.length);
    while (entries.length > 0 && (total > GLOBAL_STORAGE_LIMIT || entries.length >= SNAPSHOT_COUNT_LIMIT)) {
      const oldest = entries.shift()!;
      storage.removeItem(oldest.key);
      total -= oldest.size;
    }
    try {
      storage.setItem(storageKey, raw);
    } catch {
      raw = encode(tabs.map(withoutInlineContent));
      for (;;) {
        try { storage.setItem(storageKey, raw); return; }
        catch {
          const oldest = entries.shift();
          if (oldest === undefined) { storage.removeItem(storageKey); return; }
          storage.removeItem(oldest.key);
        }
      }
    }
  } catch { return; }
}
