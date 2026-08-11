// packages/app-core/src/lib/pinnedSessions.ts
// Pure helpers for the pinned-sessions sidebar section. The pinned id list is
// persisted in localStorage (see lib/storage.ts) and holds no server-side
// state; these functions carry the ordering/partition rules so they stay
// unit-testable without mounting Vue state.

/**
 * dataTransfer MIME type marking a session-row drag — a session dragged out
 * of a workspace group (the pinned section reads the id back on drop to pin
 * it there). Workspace-header drags and OS file drags never set it, so drop
 * targets can tell the drags apart; during dragover only the types list is
 * readable, the payload id comes out on drop.
 */
export const SESSION_ROW_DRAG_MIME = 'application/x-kimi-session-row';

/**
 * Append `id` to the pinned list (new pins land at the END of the section).
 * Returns the input unchanged when the id is already pinned.
 */
export function pinSessionId(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids;
  return [...ids, id];
}

/** Remove `id` from the pinned list (unpin / session archived or deleted). */
export function unpinSessionId(ids: string[], id: string): string[] {
  if (!ids.includes(id)) return ids;
  return ids.filter((existing) => existing !== id);
}

/**
 * Merge a drag-reordered list of the VISIBLE pinned ids with the stored list:
 * the dragged order wins, and any stored ids the UI never rendered (a pinned
 * session that has not been fetched yet) keep their relative spots at the end
 * instead of being silently unpinned.
 */
export function mergePinnedOrder(orderedVisibleIds: string[], storedIds: string[]): string[] {
  const placed = new Set(orderedVisibleIds);
  return [...orderedVisibleIds, ...storedIds.filter((id) => !placed.has(id))];
}

/**
 * Split `items` into pinned (ordered by `pinnedIds`) and unpinned (original
 * order). Ids in `pinnedIds` that have no matching item are skipped — a pinned
 * session that is not loaded yet simply does not render until it is fetched.
 */
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

/**
 * Insert `id` into `ids` before/after `targetId` (append at the END when
 * `targetId` is null or not in the list). A duplicate `id` is removed first,
 * so this also moves an already-listed id. Used when a session is dropped
 * into the pinned section at a specific spot (drag-to-pin).
 */
export function insertPinnedAt(
  ids: readonly string[],
  id: string,
  targetId: string | null,
  position: 'before' | 'after',
): string[] {
  const base = ids.filter((existing) => existing !== id);
  const index = targetId === null ? -1 : base.indexOf(targetId);
  if (index === -1) return [...base, id];
  base.splice(position === 'before' ? index : index + 1, 0, id);
  return base;
}
