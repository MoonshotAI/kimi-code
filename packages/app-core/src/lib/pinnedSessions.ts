import type { DropPosition } from './workspaceOrder';

export const SESSION_ROW_DRAG_MIME = 'application/x-kimi-session-row';
export const WORKSPACE_DRAG_MIME = 'application/x-kimi-workspace';

export interface PinnedInsertTarget {
  key: string;
  position: DropPosition;
}

export interface ParsedPinnedEntryKey {
  kind: 'workspace' | 'session';
  id: string;
}

export function pinnedWorkspaceKey(id: string): string {
  return `ws:${id}`;
}

export function pinnedSessionKey(id: string): string {
  return `session:${id}`;
}

export function parsePinnedEntryKey(key: string): ParsedPinnedEntryKey | null {
  if (key.startsWith('ws:')) {
    const id = key.slice(3);
    return id.length > 0 ? { kind: 'workspace', id } : null;
  }
  if (key.startsWith('session:')) {
    const id = key.slice(8);
    return id.length > 0 ? { kind: 'session', id } : null;
  }
  return null;
}

export function reconcilePinnedOrder(
  storedOrder: readonly string[],
  workspaceIds: readonly string[],
  sessionIds: readonly string[],
): string[] {
  const validKeys = new Set<string>();
  for (const id of workspaceIds) {
    if (id) validKeys.add(pinnedWorkspaceKey(id));
  }
  for (const id of sessionIds) {
    if (id) validKeys.add(pinnedSessionKey(id));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of storedOrder) {
    if (validKeys.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  for (const id of workspaceIds) {
    const key = pinnedWorkspaceKey(id);
    if (id && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  for (const id of sessionIds) {
    const key = pinnedSessionKey(id);
    if (id && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export function insertPinnedOrderKey(
  order: readonly string[],
  key: string,
  target?: PinnedInsertTarget,
): string[] {
  const base = order.filter((existing) => existing !== key);
  if (target) {
    const targetIdx = base.indexOf(target.key);
    if (targetIdx !== -1) {
      const insertIdx = target.position === 'before' ? targetIdx : targetIdx + 1;
      const next = [...base];
      next.splice(insertIdx, 0, key);
      return next;
    }
  }
  return [...base, key];
}

export function splitPinnedOrder(order: readonly string[]): {
  workspaceIds: string[];
  sessionIds: string[];
} {
  const workspaceIds: string[] = [];
  const sessionIds: string[] = [];
  const seenWs = new Set<string>();
  const seenSessions = new Set<string>();
  for (const key of order) {
    const parsed = parsePinnedEntryKey(key);
    if (!parsed) continue;
    if (parsed.kind === 'workspace') {
      if (!seenWs.has(parsed.id)) {
        seenWs.add(parsed.id);
        workspaceIds.push(parsed.id);
      }
    } else if (!seenSessions.has(parsed.id)) {
      seenSessions.add(parsed.id);
      sessionIds.push(parsed.id);
    }
  }
  return { workspaceIds, sessionIds };
}

export function pinSessionId(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids;
  return [...ids, id];
}

export function unpinSessionId(ids: string[], id: string): string[] {
  if (!ids.includes(id)) return ids;
  return ids.filter((existing) => existing !== id);
}

export function partitionByPinned<T extends { id: string }>(
  items: readonly T[],
  pinnedIds: readonly string[],
): { pinned: T[]; unpinned: T[] } {
  const pinnedSet = new Set(pinnedIds);
  const byId = new Map<string, T>();
  const unpinned: T[] = [];
  for (const item of items) {
    if (pinnedSet.has(item.id)) byId.set(item.id, item);
    else unpinned.push(item);
  }
  const pinned: T[] = [];
  for (const id of pinnedIds) {
    const item = byId.get(id);
    if (item !== undefined) pinned.push(item);
  }
  return { pinned, unpinned };
}
