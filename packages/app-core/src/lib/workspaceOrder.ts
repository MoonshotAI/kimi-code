// packages/app-core/src/lib/workspaceOrder.ts
// Pure helpers for the sidebar's user-defined workspace order. Kept separate
// from the composable so the reconciliation and sort rules are unit-testable
// without mounting Vue state.

/**
 * Merge the set of currently-known workspace ids into the persisted order.
 * - Ids that no longer exist are dropped.
 * - Newly-seen ids are prepended (newest first — the closest signal to a
 *   creation time we have, since workspaces carry no createdAt timestamp).
 * - Returns `null` when nothing changed, so callers can skip a redundant write.
 * - Returns `null` for an empty `currentIds` so an initial not-yet-loaded state
 *   never wipes the stored order.
 *
 * `initialRank` (id → recency-ish timestamp, e.g. the wire `last_opened_at`)
 * applies ONLY when nothing is stored yet (first launch, fresh device): the
 * brand-new initial order is seeded by rank descending instead of inheriting
 * the wire's append order. Once any order exists, new ids keep prepending.
 */
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

/**
 * Sort items by their position in `order`. Items absent from `order` sort to
 * the front (a just-discovered workspace appears at the top immediately, before
 * the reconciliation watcher records it). The sort is stable, so items sharing
 * a position keep their relative order.
 */
export function sortByWorkspaceOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const index = new Map(order.map((id, i) => [id, i]));
  return items.toSorted((a, b) => (index.get(a.id) ?? -1) - (index.get(b.id) ?? -1));
}

export type DropPosition = 'before' | 'after';

/**
 * Move `fromId` so it lands immediately before or after `toId` — matching the
 * insertion marker shown in the sidebar (a line at the top of the target for
 * "before", at the bottom for "after"). Returns the original array unchanged
 * when either id is missing or they are the same. After the source is removed,
 * a downward move shifts the target left by one, so the target index is
 * rebased before applying the position.
 */
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

// ---------------------------------------------------------------------------
// Recency sort mode ('recent'): groups follow their latest session activity.
// ---------------------------------------------------------------------------

/** Sidebar workspace sort mode: the user's dragged order, or latest activity. */
export type WorkspaceSortMode = 'manual' | 'recent';

/**
 * Sort items by their recency key, newest first. Items without a key sort to
 * the bottom (`-Infinity`), so a workspace with neither session activity nor a
 * `last_opened_at` never outranks one that has either. Stable: items sharing a
 * key keep their relative order.
 */
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

/**
 * Fold the currently-computed per-workspace recency keys into the persisted
 * floor table. The floor is monotonic — it only ever advances — so removing
 * the anchor session (archive/delete) collapses the current key but leaves the
 * group's position untouched; another group still overtakes it the moment it
 * sees real new activity. `changed` lets the caller skip a redundant write.
 */
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

/**
 * Current activity key per workspace: max(updatedAt) over the session pool's
 * live rows (child sessions and archived rows excluded, matching what the
 * grouped sidebar renders). Feeds `reconcileRecencyFloor`; `workspaceIdFor`
 * resolves a session to its workspace (the facade's root-key join).
 */
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

/**
 * Recency key per workspace for the 'recent' sort: max(persisted floor, wire
 * `last_opened_at`). last_opened_at doubles as a just-added workspace's floor
 * — it opens at the top until real session activity takes over. Both inputs
 * are monotonic while a workspace lives, so a group only ever floats up, never
 * sinks mid-session (e.g. on refresh while its first session page is still
 * loading).
 */
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

/**
 * Drop floor entries for workspaces that are gone (covers every removal path:
 * local delete, remote WS event, hide). Only call with the COMPLETE known id
 * set — a partially-loaded set would prune live entries (same contract as the
 * order reconciler's loading guard).
 */
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
