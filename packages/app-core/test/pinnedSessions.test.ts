import { beforeEach, describe, expect, it, vi } from 'vitest';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

import {
  STORAGE_KEYS,
  insertPinnedOrderKey,
  loadPinnedOrder,
  parsePinnedEntryKey,
  pinnedSessionKey,
  pinnedWorkspaceKey,
  reconcilePinnedOrder,
  savePinnedOrder,
  splitPinnedOrder,
} from '../src/lib';

describe('pinned entry order helpers', () => {
  beforeEach(() => {
    memStorage.clear();
  });

  it('builds and parses workspace and session entry keys', () => {
    expect(parsePinnedEntryKey(pinnedWorkspaceKey('ws-1'))).toEqual({
      kind: 'workspace',
      id: 'ws-1',
    });
    expect(parsePinnedEntryKey(pinnedSessionKey('s-1'))).toEqual({
      kind: 'session',
      id: 's-1',
    });
    expect(parsePinnedEntryKey('ws:')).toBeNull();
    expect(parsePinnedEntryKey('session:')).toBeNull();
    expect(parsePinnedEntryKey('other:1')).toBeNull();
  });

  it('reconciles stored interleaved order, prunes stale entries and appends unrecorded pins at the tail', () => {
    const reconciled = reconcilePinnedOrder(
      ['session:s-2', 'ws:gone', 'ws:ws-1', 'session:s-2'],
      ['ws-1', 'ws-2'],
      ['s-1', 's-2'],
    );
    expect(reconciled).toEqual(['session:s-2', 'ws:ws-1', 'ws:ws-2', 'session:s-1']);
    expect(splitPinnedOrder(reconciled)).toEqual({
      workspaceIds: ['ws-1', 'ws-2'],
      sessionIds: ['s-2', 's-1'],
    });
  });

  it('appends new entries to the tail by default and inserts before or after a drop target when given', () => {
    const base = ['ws:ws-1', 'session:s-1'];
    expect(insertPinnedOrderKey(base, 'session:s-2')).toEqual([
      'ws:ws-1',
      'session:s-1',
      'session:s-2',
    ]);
    expect(
      insertPinnedOrderKey(base, 'session:s-2', { key: 'ws:ws-1', position: 'before' }),
    ).toEqual(['session:s-2', 'ws:ws-1', 'session:s-1']);
    expect(
      insertPinnedOrderKey(base, 'ws:ws-2', { key: 'ws:ws-1', position: 'after' }),
    ).toEqual(['ws:ws-1', 'ws:ws-2', 'session:s-1']);
    expect(
      insertPinnedOrderKey(base, 'session:s-2', { key: 'ws:missing', position: 'before' }),
    ).toEqual(['ws:ws-1', 'session:s-1', 'session:s-2']);
  });

  it('loads and saves only valid pinned order keys in storage', () => {
    savePinnedOrder(['session:s-1', 'ws:ws-1']);
    expect(loadPinnedOrder()).toEqual(['session:s-1', 'ws:ws-1']);

    localStorage.setItem(
      STORAGE_KEYS.pinnedOrder,
      JSON.stringify(['session:s-1', 'invalid', 123, null, 'ws:ws-2']),
    );
    expect(loadPinnedOrder()).toEqual(['session:s-1', 'ws:ws-2']);
  });
});
