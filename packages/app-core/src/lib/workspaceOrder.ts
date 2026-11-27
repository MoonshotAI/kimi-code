
export function reconcileWorkspaceOrder(
  currentIds: string[],
  storedOrder: string[],
  initialRank?: ReadonlyMap<string, number>,
): string[] | null {
  if (currentIds.length === 0) return null;
  const currentSet = new Set(currentIds);
  const kept = storedOrder.filter((id) => currentSet.has(id));
  const newIds = currentIds.filter((id) => !storedOrder.includes(id));
  if (newIds.length === 0 && kept.length === storedOrder.length) return null;
  if (storedOrder.length === 0 && initialRank !== undefined) {
    return newIds.toSorted(
      (a, b) =>
        (initialRank.get(b) ?? Number.NEGATIVE_INFINITY) -
        (initialRank.get(a) ?? Number.NEGATIVE_INFINITY),
    );
  }
  return [...newIds, ...kept];
}

export function sortByWorkspaceOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const index = new Map(order.map((id, i) => [id, i]));
  return items.toSorted((a, b) => (index.get(a.id) ?? -1) - (index.get(b.id) ?? -1));
}

export type DropPosition = 'before' | 'after';

export function moveInOrder(
  order: string[],
  fromId: string,
  toId: string,
  position: DropPosition = 'before',
): string[] {
  const fromIdx = order.indexOf(fromId);
  const toIdx = order.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return order;
  const next = [...order];
  next.splice(fromIdx, 1);
  const shiftedToIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
  const insertIdx = position === 'before' ? shiftedToIdx : shiftedToIdx + 1;
  next.splice(insertIdx, 0, fromId);
  return next;
}

export type WorkspaceSortMode = 'manual' | 'recent';

export function sortWorkspacesByRecent<T extends { id: string }>(
  items: T[],
  recencyKey: ReadonlyMap<string, number>,
): T[] {
  return items.toSorted(
    (a, b) =>
      (recencyKey.get(b.id) ?? Number.NEGATIVE_INFINITY) -
      (recencyKey.get(a.id) ?? Number.NEGATIVE_INFINITY),
  );
}

export function reconcileRecencyFloor(
  floor: Record<string, number>,
  currentKeys: ReadonlyMap<string, number>,
): { next: Record<string, number>; changed: boolean } {
  let changed = false;
  const next = { ...floor };
  for (const [id, key] of currentKeys) {
    if (key > (next[id] ?? Number.NEGATIVE_INFINITY)) {
      next[id] = key;
      changed = true;
    }
  }
  return { next, changed };
}

export function currentActivityKeys<T extends { parentSessionId?: string; archived?: boolean; updatedAt: string }>(
  sessions: readonly T[],
  workspaceIdFor: (session: T) => string,
): Map<string, number> {
  const keys = new Map<string, number>();
  for (const s of sessions) {
    if (s.parentSessionId || s.archived) continue;
    const t = new Date(s.updatedAt).getTime();
    if (Number.isNaN(t)) continue;
    const wid = workspaceIdFor(s);
    if (t > (keys.get(wid) ?? Number.NEGATIVE_INFINITY)) keys.set(wid, t);
  }
  return keys;
}

export function buildWorkspaceRecencyKeys<T extends { id: string; lastOpenedAt?: string }>(
  workspaces: readonly T[],
  floor: Record<string, number>,
): Map<string, number> {
  const keys = new Map<string, number>();
  for (const w of workspaces) {
    const f = floor[w.id] ?? Number.NEGATIVE_INFINITY;
    const parsed = w.lastOpenedAt ? Date.parse(w.lastOpenedAt) : Number.NaN;
    const opened = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    keys.set(w.id, Math.max(f, opened));
  }
  return keys;
}

export function pruneRecencyFloor(
  floor: Record<string, number>,
  aliveIds: ReadonlySet<string>,
): { next: Record<string, number>; changed: boolean } {
  const ids = Object.keys(floor);
  if (!ids.some((id) => !aliveIds.has(id))) return { next: floor, changed: false };
  const next: Record<string, number> = {};
  for (const id of ids) {
    if (aliveIds.has(id)) next[id] = floor[id]!;
  }
  return { next, changed: true };
}
