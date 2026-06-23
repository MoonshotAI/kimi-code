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

/**
 * Move `fromId` so it lands immediately before `toId` — matching the
 * "drop-before" insertion marker shown in the sidebar. Returns the original
 * array unchanged when either id is missing or they are the same. After the
 * source is removed, a downward move shifts the target left by one, so the
 * insertion index is adjusted to keep the result "before the target".
 */
export function moveInOrder(order: string[], fromId: string, toId: string): string[] {
  const fromIdx = order.indexOf(fromId);
  const toIdx = order.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return order;
  const next = [...order];
  next.splice(fromIdx, 1);
  const insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
  next.splice(insertIdx, 0, fromId);
  return next;
}
