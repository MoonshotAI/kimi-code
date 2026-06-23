import { describe, expect, it } from 'vitest';
import {
  moveInOrder,
  reconcileWorkspaceOrder,
  sortByWorkspaceOrder,
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
  it('moves an item down onto the target', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item up onto the target', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when from === to', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });

  it('returns the original order when an id is missing', () => {
    expect(moveInOrder(['a', 'b'], 'x', 'b')).toEqual(['a', 'b']);
    expect(moveInOrder(['a', 'b'], 'a', 'x')).toEqual(['a', 'b']);
  });
});
