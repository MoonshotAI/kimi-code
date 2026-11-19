import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionRuntimeStore } from '../src/stores/sessionRuntime';
import { sessionsStore } from '../src/stores/sessions';

beforeEach(() => {
  const store = sessionRuntimeStore();
  store.runtimes.clear();
  store.profileWriteChainBySid.clear();
  store.lastTurnReasonChangeBySession = {};
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runtimeFor / peekRuntime', () => {
  it('runtimeFor creates the entry once and returns the same object on repeat calls', () => {
    const store = sessionRuntimeStore();
    expect(store.runtimes.size).toBe(0);
    const first = store.runtimeFor('s1');
    expect(store.runtimes.size).toBe(1);
    expect(store.runtimeFor('s1')).toBe(first);
  });

  it('peekRuntime returns undefined without creating an entry', () => {
    const store = sessionRuntimeStore();
    expect(store.peekRuntime('s1')).toBeUndefined();
    expect(store.runtimes.size).toBe(0);
    store.runtimeFor('s1');
    expect(store.peekRuntime('s1')).toBe(store.runtimes.get('s1'));
  });
});

describe('dispose', () => {
  it('deletes the entry and the record keys', () => {
    const store = sessionRuntimeStore();
    store.runtimeFor('s1');
    store.lastTurnReasonChangeBySession = { s1: 7 };

    store.dispose('s1');

    expect(store.peekRuntime('s1')).toBeUndefined();
    expect(store.lastTurnReasonChangeBySession).toEqual({});
  });

  it('clears record keys even when no entry exists', () => {
    const store = sessionRuntimeStore();
    store.lastTurnReasonChangeBySession = { s1: 3 };

    store.dispose('s1');

    expect(store.lastTurnReasonChangeBySession).toEqual({});
  });
});

describe('profileWriteChainBySid', () => {
  it('survives dispose so a restored session still serializes behind the in-flight write', () => {
    const store = sessionRuntimeStore();
    store.runtimeFor('s1');
    const chain = Promise.resolve();
    store.profileWriteChainBySid.set('s1', chain);

    store.dispose('s1');

    expect(store.peekRuntime('s1')).toBeUndefined();
    expect(store.profileWriteChainBySid.get('s1')).toBe(chain);
  });
});

describe('turn records', () => {
  it('noteLastTurnReasonChange counts the changes per session', () => {
    const store = sessionRuntimeStore();
    store.noteLastTurnReasonChange('s1');
    store.noteLastTurnReasonChange('s1');
    store.noteLastTurnReasonChange('s2');
    expect(store.lastTurnReasonChangeBySession).toEqual({ s1: 2, s2: 1 });
  });
});