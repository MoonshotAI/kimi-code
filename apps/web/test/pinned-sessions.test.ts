import { describe, expect, it } from 'vitest';
import {
  partitionByPinned,
  pinSessionId,
  unpinSessionId,
} from '@moonshot-ai/app-core/lib';

describe('pinSessionId', () => {
  it('appends a new pin to the list', () => {
    expect(pinSessionId(['s-1', 's-2'], 's-3')).toEqual(['s-1', 's-2', 's-3']);
  });

  it('returns the input unchanged when the id is already pinned', () => {
    const ids = ['s-1', 's-2'];
    expect(pinSessionId(ids, 's-1')).toBe(ids);
  });
});

describe('unpinSessionId', () => {
  it('removes the id, keeping the remaining membership', () => {
    expect(unpinSessionId(['s-1', 's-2', 's-3'], 's-2')).toEqual(['s-1', 's-3']);
  });

  it('returns the input unchanged when the id is not pinned', () => {
    const ids = ['s-1'];
    expect(unpinSessionId(ids, 's-9')).toBe(ids);
  });
});

describe('partitionByPinned', () => {
  const sessions = [{ id: 's-1' }, { id: 's-2' }, { id: 's-3' }, { id: 's-4' }];

  it('partitions by membership in the pinned id list', () => {
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
