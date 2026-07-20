import { describe, expect, it } from 'vitest';
import {
  moveInOrder,
  reconcileWorkspaceOrder,
  sortByWorkspaceOrder,
  sortWorkspacesByRecent,
  workspaceRecentActivity,
} from '../src/lib/workspaceOrder';

describe('reconcileWorkspaceOrder', () => {
  it('returns null for an empty current set so a not-yet-loaded state never wipes the order', () => {
    expect(reconcileWorkspaceOrder([], ['ws-1', 'ws-2'])).toBeNull();
  });

  it('returns null when the id set is unchanged (a daemon reorder must not rewrite the order)', () => {
    expect(reconcileWorkspaceOrder(['ws-2', 'ws-1'], ['ws-1', 'ws-2'])).toBeNull();
  });

  it('prepends newly-seen ids (newest first)', () => {
    expect(reconcileWorkspaceOrder(['ws-3', 'ws-1', 'ws-2'], ['ws-1', 'ws-2'])).toEqual([
      'ws-3',
      'ws-1',
      'ws-2',
    ]);
  });

  it('drops ids that no longer exist', () => {
    expect(reconcileWorkspaceOrder(['ws-1'], ['ws-2', 'ws-1', 'ws-3'])).toEqual(['ws-1']);
  });

  it('snapshots the initial order on first load', () => {
    expect(reconcileWorkspaceOrder(['ws-2', 'ws-1'], [])).toEqual(['ws-2', 'ws-1']);
  });

  // Regression guard for the "dragged empty workspace bounces back on refresh"
  // bug: if the reconciler is ever fed a *partial* workspace set, it drops the
  // missing workspace and the next call (with the full set) re-adds it at the
  // top. The watcher avoids this by only reconciling once loading has settled,
  // but the reconciler's own "drop + re-add at top" behavior is what makes the
  // guard necessary — pinning it here documents the contract.
  it('drops a temporarily-absent workspace and re-adds it at the top (why the watcher waits for load)', () => {
    const dragged = ['ws-b', 'ws-c', 'ws-empty'];
    const afterPartial = reconcileWorkspaceOrder(['ws-b', 'ws-c'], dragged);
    expect(afterPartial).toEqual(['ws-b', 'ws-c']);
    const afterFull = reconcileWorkspaceOrder(['ws-empty', 'ws-b', 'ws-c'], afterPartial!);
    expect(afterFull).toEqual(['ws-empty', 'ws-b', 'ws-c']);
  });
});

describe('sortByWorkspaceOrder', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('orders items by their position in the order list', () => {
    expect(sortByWorkspaceOrder(items, ['c', 'a', 'b']).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('places unknown ids at the front, keeping their relative order', () => {
    expect(sortByWorkspaceOrder(items, ['b']).map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the input array', () => {
    const copy = [...items];
    sortByWorkspaceOrder(items, ['c', 'a', 'b']);
    expect(items).toEqual(copy);
  });
});

describe('sortWorkspacesByRecent', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('orders workspaces by most-recent activity first', () => {
    const lastEditedAt = new Map<string, number>([
      ['a', 100],
      ['b', 300],
      ['c', 200],
    ]);
    expect(sortWorkspacesByRecent(items, lastEditedAt).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('places workspaces without a timestamp (no sessions) at the end', () => {
    const lastEditedAt = new Map<string, number>([['b', 100]]);
    expect(sortWorkspacesByRecent(items, lastEditedAt).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('keeps relative order when timestamps tie (stable sort)', () => {
    const lastEditedAt = new Map<string, number>([
      ['a', 100],
      ['b', 100],
      ['c', 100],
    ]);
    expect(sortWorkspacesByRecent(items, lastEditedAt).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const copy = [...items];
    sortWorkspacesByRecent(items, new Map([['c', 1]]));
    expect(items).toEqual(copy);
  });
});

describe('workspaceRecentActivity', () => {
  const idFor = (s: { workspaceId?: string; cwd: string }): string => s.workspaceId ?? s.cwd;
  const session = (
    workspaceId: string,
    updatedAt: number,
    parentSessionId?: string,
  ): { workspaceId: string; cwd: string; updatedAt: string; parentSessionId?: string } => ({
    workspaceId,
    cwd: `/ws/${workspaceId}`,
    updatedAt: new Date(updatedAt).toISOString(),
    parentSessionId,
  });

  it('seeds a just-added workspace (no sessions) so it sorts at the top', () => {
    const items = [{ id: 'a' }, { id: 'ws-new' }];
    // The seeded add time ranks ahead of workspaces with older activity...
    const activity = workspaceRecentActivity([session('a', 10)], { 'ws-new': 50 }, idFor);
    expect(sortWorkspacesByRecent(items, activity).map((x) => x.id)).toEqual(['ws-new', 'a']);
    // ...but still behind workspaces with newer activity.
    const newer = workspaceRecentActivity([session('a', 100)], { 'ws-new': 50 }, idFor);
    expect(sortWorkspacesByRecent(items, newer).map((x) => x.id)).toEqual(['a', 'ws-new']);
  });

  it('lets real session activity take over once it is newer than the add time', () => {
    const activity = workspaceRecentActivity([session('ws-new', 500)], { 'ws-new': 50 }, idFor);
    expect(activity.get('ws-new')).toBe(500);
  });

  it('keeps the add time when the workspace only has older sessions', () => {
    const activity = workspaceRecentActivity([session('ws-new', 10)], { 'ws-new': 50 }, idFor);
    expect(activity.get('ws-new')).toBe(50);
  });

  it('excludes child (side chat) sessions, matching the sidebar list', () => {
    const activity = workspaceRecentActivity([session('a', 999, 'parent-1')], {}, idFor);
    expect(activity.has('a')).toBe(false);
  });
});

describe('moveInOrder', () => {
  // The drop indicator is a line at the top (before) or bottom (after) of the
  // target, so the result must place fromId immediately next to toId.
  it('moves an item down so it lands before the target', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'a', 'c', 'before')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('moves an item up so it lands before the target', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('inserts after the target when position is "after"', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('can move an item to the very bottom by dropping after the last item', () => {
    expect(moveInOrder(['A', 'B', 'C'], 'A', 'C', 'after')).toEqual(['B', 'C', 'A']);
  });

  it('swaps with the adjacent item when dropping after it', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op when dropping before the adjacent item in the indicator direction', () => {
    // "before b" keeps a above b; to move a below b you drop after b instead.
    expect(moveInOrder(['a', 'b', 'c'], 'a', 'b', 'before')).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when from === to', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });

  it('returns the original order when an id is missing', () => {
    expect(moveInOrder(['a', 'b'], 'x', 'b')).toEqual(['a', 'b']);
    expect(moveInOrder(['a', 'b'], 'a', 'x')).toEqual(['a', 'b']);
  });
});
