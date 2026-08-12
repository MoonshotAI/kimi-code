import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceRecencyKeys,
  currentActivityKeys,
  moveInOrder,
  pruneRecencyFloor,
  reconcileRecencyFloor,
  reconcileWorkspaceOrder,
  sortByWorkspaceOrder,
  sortWorkspacesByRecent,
} from '@moonshot-ai/app-core/lib';

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

describe('reconcileWorkspaceOrder initialRank', () => {
  const rank = new Map([
    ['ws-1', 100],
    ['ws-2', 300],
    ['ws-3', 200],
  ]);

  it('seeds the first-load order by rank descending instead of the wire append order', () => {
    expect(reconcileWorkspaceOrder(['ws-1', 'ws-2', 'ws-3'], [], rank)).toEqual([
      'ws-2',
      'ws-3',
      'ws-1',
    ]);
  });

  it('sinks ids without a rank to the bottom, keeping their wire order', () => {
    expect(reconcileWorkspaceOrder(['ws-1', 'ws-x', 'ws-y', 'ws-2'], [], rank)).toEqual([
      'ws-2',
      'ws-1',
      'ws-x',
      'ws-y',
    ]);
  });

  it('ignores initialRank once any order is stored (new ids keep prepending)', () => {
    expect(reconcileWorkspaceOrder(['ws-3', 'ws-1', 'ws-2'], ['ws-1', 'ws-2'], rank)).toEqual([
      'ws-3',
      'ws-1',
      'ws-2',
    ]);
  });

  it('keeps the legacy wire-order snapshot when no rank is provided', () => {
    expect(reconcileWorkspaceOrder(['ws-2', 'ws-1'], [])).toEqual(['ws-2', 'ws-1']);
  });
});

describe('sortWorkspacesByRecent', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('orders items by recency key, newest first', () => {
    const keys = new Map([
      ['a', 100],
      ['b', 400],
      ['c', 200],
      ['d', 300],
    ]);
    expect(sortWorkspacesByRecent(items, keys).map((x) => x.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('sinks items without a key to the bottom, keeping their relative order', () => {
    const keys = new Map([['c', 200]]);
    expect(sortWorkspacesByRecent(items, keys).map((x) => x.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('is stable for equal keys', () => {
    const keys = new Map([
      ['a', 100],
      ['c', 100],
    ]);
    expect(sortWorkspacesByRecent(items, keys).map((x) => x.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('does not mutate the input array', () => {
    const copy = [...items];
    sortWorkspacesByRecent(items, new Map([['a', 1]]));
    expect(items).toEqual(copy);
  });
});

describe('reconcileRecencyFloor', () => {
  it('advances the floor to a newer key and reports the change', () => {
    const { next, changed } = reconcileRecencyFloor({ 'ws-1': 100 }, new Map([['ws-1', 200]]));
    expect(next).toEqual({ 'ws-1': 200 });
    expect(changed).toBe(true);
  });

  it('never regresses: a collapsed current key (anchor archived/deleted) leaves the floor untouched', () => {
    const floor = { 'ws-1': 200 };
    const { next, changed } = reconcileRecencyFloor(floor, new Map([['ws-1', 100]]));
    expect(next).toEqual({ 'ws-1': 200 });
    expect(changed).toBe(false);
  });

  it('seeds newly-seen workspaces', () => {
    const { next, changed } = reconcileRecencyFloor({}, new Map([['ws-1', 100]]));
    expect(next).toEqual({ 'ws-1': 100 });
    expect(changed).toBe(true);
  });

  it('reports no change when every key is already covered by the floor', () => {
    const { changed } = reconcileRecencyFloor(
      { 'ws-1': 200, 'ws-2': 300 },
      new Map([
        ['ws-1', 200],
        ['ws-2', 150],
      ]),
    );
    expect(changed).toBe(false);
  });

  it('does not mutate the input floor', () => {
    const floor = { 'ws-1': 100 };
    reconcileRecencyFloor(floor, new Map([['ws-1', 200]]));
    expect(floor).toEqual({ 'ws-1': 100 });
  });
});

describe('currentActivityKeys', () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const byWorkspace = (s: { workspaceId: string }) => s.workspaceId;

  it('takes the max updatedAt per workspace', () => {
    const keys = currentActivityKeys(
      [
        { workspaceId: 'a', updatedAt: at(100) },
        { workspaceId: 'a', updatedAt: at(300) },
        { workspaceId: 'a', updatedAt: at(200) },
        { workspaceId: 'b', updatedAt: at(50) },
      ],
      byWorkspace,
    );
    expect(keys.get('a')).toBe(300);
    expect(keys.get('b')).toBe(50);
  });

  it('excludes child sessions and archived rows (matching the grouped sidebar)', () => {
    const keys = currentActivityKeys(
      [
        { workspaceId: 'a', updatedAt: at(100) },
        { workspaceId: 'a', updatedAt: at(900), parentSessionId: 'parent-1' },
        { workspaceId: 'a', updatedAt: at(800), archived: true },
      ],
      byWorkspace,
    );
    expect(keys.get('a')).toBe(100);
  });

  it('skips rows with an unparseable updatedAt', () => {
    const keys = currentActivityKeys(
      [
        { workspaceId: 'a', updatedAt: 'not-a-date' },
        { workspaceId: 'a', updatedAt: at(100) },
      ],
      byWorkspace,
    );
    expect(keys.get('a')).toBe(100);
  });
});

describe('buildWorkspaceRecencyKeys', () => {
  it('takes max(floor, last_opened_at) per workspace', () => {
    const keys = buildWorkspaceRecencyKeys(
      [
        { id: 'a', lastOpenedAt: new Date(100).toISOString() },
        { id: 'b', lastOpenedAt: new Date(500).toISOString() },
        { id: 'c', lastOpenedAt: new Date(300).toISOString() },
      ],
      { a: 400, b: 200 },
    );
    expect(keys.get('a')).toBe(400);
    expect(keys.get('b')).toBe(500);
    expect(keys.get('c')).toBe(300);
  });

  it('a just-added workspace (last_opened_at only) outranks an idle one', () => {
    const keys = buildWorkspaceRecencyKeys(
      [{ id: 'fresh', lastOpenedAt: new Date(1000).toISOString() }, { id: 'old' }],
      { old: 10 },
    );
    const sorted = sortWorkspacesByRecent([{ id: 'old' }, { id: 'fresh' }], keys);
    expect(sorted.map((w) => w.id)).toEqual(['fresh', 'old']);
  });

  it('treats a missing or unparseable lastOpenedAt as no key', () => {
    const keys = buildWorkspaceRecencyKeys(
      [
        { id: 'a', lastOpenedAt: 'garbage' },
        { id: 'b' },
      ],
      {},
    );
    expect(keys.get('a')).toBe(Number.NEGATIVE_INFINITY);
    expect(keys.get('b')).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('pruneRecencyFloor', () => {
  it('drops entries for gone workspaces and reports the change', () => {
    const { next, changed } = pruneRecencyFloor(
      { 'ws-1': 100, 'ws-2': 200, 'ws-3': 300 },
      new Set(['ws-1', 'ws-3']),
    );
    expect(next).toEqual({ 'ws-1': 100, 'ws-3': 300 });
    expect(changed).toBe(true);
  });

  it('returns the input unchanged when every entry is alive', () => {
    const floor = { 'ws-1': 100 };
    const { next, changed } = pruneRecencyFloor(floor, new Set(['ws-1', 'ws-2']));
    expect(next).toBe(floor);
    expect(changed).toBe(false);
  });

  it('does not mutate the input floor', () => {
    const floor = { 'ws-1': 100, 'ws-2': 200 };
    pruneRecencyFloor(floor, new Set(['ws-1']));
    expect(floor).toEqual({ 'ws-1': 100, 'ws-2': 200 });
  });
});
