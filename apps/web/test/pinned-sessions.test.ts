import { describe, expect, it } from 'vitest';
import {
  insertPinnedAt,
  mergePinnedOrder,
  partitionByPinned,
  pinSessionId,
  unpinSessionId,
} from '@moonshot-ai/app-core/lib';

describe('pinSessionId', () => {
  it('appends a new pin to the END of the list', () => {
    expect(pinSessionId(['s-1', 's-2'], 's-3')).toEqual(['s-1', 's-2', 's-3']);
  });

  it('returns the input unchanged when the id is already pinned', () => {
    const ids = ['s-1', 's-2'];
    expect(pinSessionId(ids, 's-1')).toBe(ids);
  });
});

describe('unpinSessionId', () => {
  it('removes the id, keeping the remaining order', () => {
    expect(unpinSessionId(['s-1', 's-2', 's-3'], 's-2')).toEqual(['s-1', 's-3']);
  });

  it('returns the input unchanged when the id is not pinned', () => {
    const ids = ['s-1'];
    expect(unpinSessionId(ids, 's-9')).toBe(ids);
  });
});

describe('mergePinnedOrder', () => {
  it('keeps the dragged order of the visible ids', () => {
    expect(mergePinnedOrder(['s-3', 's-1', 's-2'], ['s-1', 's-2', 's-3'])).toEqual([
      's-3',
      's-1',
      's-2',
    ]);
  });

  it('appends stored ids the UI did not render (not yet fetched) at the end', () => {
    expect(mergePinnedOrder(['s-2', 's-1'], ['s-1', 's-2', 's-3'])).toEqual(['s-2', 's-1', 's-3']);
  });

  it('keeps visible ids even when they are absent from the stored list', () => {
    expect(mergePinnedOrder(['s-1', 's-x'], ['s-1', 's-2'])).toEqual(['s-1', 's-x', 's-2']);
  });
});

describe('partitionByPinned', () => {
  const sessions = [{ id: 's-1' }, { id: 's-2' }, { id: 's-3' }, { id: 's-4' }];

  it('orders pinned items by the pinned id list, not by list order', () => {
    const { pinned } = partitionByPinned(sessions, ['s-3', 's-1']);
    expect(pinned.map((s) => s.id)).toEqual(['s-3', 's-1']);
  });

  it('keeps unpinned items in their original order', () => {
    const { unpinned } = partitionByPinned(sessions, ['s-3', 's-1']);
    expect(unpinned.map((s) => s.id)).toEqual(['s-2', 's-4']);
  });

  it('skips pinned ids with no matching session (not loaded yet)', () => {
    const { pinned, unpinned } = partitionByPinned(sessions, ['s-9', 's-2']);
    expect(pinned.map((s) => s.id)).toEqual(['s-2']);
    expect(unpinned.map((s) => s.id)).toEqual(['s-1', 's-3', 's-4']);
  });

  it('returns everything unpinned for an empty pinned list', () => {
    const { pinned, unpinned } = partitionByPinned(sessions, []);
    expect(pinned).toEqual([]);
    expect(unpinned).toEqual(sessions);
  });
});

describe('insertPinnedAt', () => {
  it('inserts before the target row', () => {
    expect(insertPinnedAt(['s-1', 's-2', 's-3'], 's-9', 's-2', 'before')).toEqual([
      's-1',
      's-9',
      's-2',
      's-3',
    ]);
  });

  it('inserts after the target row', () => {
    expect(insertPinnedAt(['s-1', 's-2', 's-3'], 's-9', 's-2', 'after')).toEqual([
      's-1',
      's-2',
      's-9',
      's-3',
    ]);
  });

  it('appends at the END when the target is null (drop on the section body)', () => {
    expect(insertPinnedAt(['s-1', 's-2'], 's-9', null, 'after')).toEqual(['s-1', 's-2', 's-9']);
  });

  it('appends at the END when the target is not in the list', () => {
    expect(insertPinnedAt(['s-1', 's-2'], 's-9', 's-7', 'before')).toEqual(['s-1', 's-2', 's-9']);
  });

  it('moves an already-listed id instead of duplicating it', () => {
    expect(insertPinnedAt(['s-1', 's-2', 's-3'], 's-1', 's-3', 'after')).toEqual([
      's-2',
      's-3',
      's-1',
    ]);
  });
});
