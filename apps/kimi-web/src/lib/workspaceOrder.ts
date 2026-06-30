// apps/kimi-web/src/lib/workspaceOrder.ts
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
 */
export function reconcileWorkspaceOrder(
  currentIds: string[],
  storedOrder: string[],
): string[] | null {
  if (currentIds.length === 0) return null;
  const currentSet = new Set(currentIds);
  const kept = storedOrder.filter((id) => currentSet.has(id));
  const newIds = currentIds.filter((id) => !storedOrder.includes(id));
  if (newIds.length === 0 && kept.length === storedOrder.length) return null;
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

/** Sidebar workspace sort mode. `manual` keeps the user-defined (dragged)
 *  order; `recent` orders by each workspace's most recent session activity. */
export type WorkspaceSortMode = 'manual' | 'recent';

/**
 * Sort workspaces by their most recent session activity, newest first.
 * `lastEditedAt` maps a workspace id to the latest `session.updatedAt`
 * (epoch ms) among its sessions. Workspaces absent from the map (no sessions
 * yet) sort to the end. The sort is stable and does not mutate the input.
 */
export function sortWorkspacesByRecent<T extends { id: string }>(
  workspaces: T[],
  lastEditedAt: ReadonlyMap<string, number>,
): T[] {
  return workspaces.toSorted(
    (a, b) =>
      (lastEditedAt.get(b.id) ?? Number.NEGATIVE_INFINITY) -
      (lastEditedAt.get(a.id) ?? Number.NEGATIVE_INFINITY),
  );
}
