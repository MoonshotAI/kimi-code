// packages/app-core/src/lib/pinnedSessions.ts
// Pure helpers for the pinned-sessions sidebar section. The pinned id list is
// persisted in localStorage (see lib/storage.ts) and holds no server-side
// state; it is a membership SET — the section renders in recency order
// (updatedAt desc, owned by the facade), so the stored order carries no
// meaning. These functions carry the membership/partition rules so they stay
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
 * Add `id` to the pinned list. Returns the input unchanged when the id is
 * already pinned.
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
