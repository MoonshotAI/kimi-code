/**
 * Scenario: the sessions Pinia store is the truth source for the session list,
 * the active session id, and the pinned-id list; the facade's rawState
 * accessors bridge to it. Responsibilities: the mutation-funnel actions behave
 * (recency sort, id dedup, pin persistence), and the facade bridge reads and
 * writes through to the store with reactive tracking intact.
 * Run: cd packages/app-client && npx vitest run test/sessions-store.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory localStorage so the pin list's persistence round-trips under the
// node test environment (storage.ts touches globalThis.localStorage). Stubbed
// before any store instantiation happens (stores initialize on first access,
// inside the tests below).
const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

import type { AppSession, KimiWebApi } from '@moonshot-ai/app-core/api';
import { loadPinnedSessions } from '@moonshot-ai/app-core/lib';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { sessionsStore } from '../src/stores/sessions';

function makeSession(id: string, updatedAt: string): AppSession {
  return { id, title: `Session ${id}`, createdAt: updatedAt, updatedAt, cwd: '/workspace' } as AppSession;
}

beforeEach(() => {
  memStorage.clear();
  const store = sessionsStore();
  store.setSessions([]);
  store.setActiveSessionId(undefined);
  store.unpinSessions([...store.pinnedSessionIds]);
});

describe('sessionsStore (mutation funnel)', () => {
  it('starts empty', () => {
    const store = sessionsStore();
    expect(store.sessions).toEqual([]);
    expect(store.activeSessionId).toBeUndefined();
    expect(store.pinnedSessionIds).toEqual([]);
  });

  it('sets and replaces the session list', () => {
    const store = sessionsStore();
    store.setSessions([makeSession('a', '2026-01-02T00:00:00.000Z')]);
    expect(store.sessions.map((s) => s.id)).toEqual(['a']);
    store.setSessions([makeSession('b', '2026-01-01T00:00:00.000Z')]);
    expect(store.sessions.map((s) => s.id)).toEqual(['b']);
  });

  it('updates one session in place and ignores unknown ids', () => {
    const store = sessionsStore();
    store.setSessions([makeSession('a', '2026-01-01T00:00:00.000Z')]);
    store.updateSession('a', (s) => ({ ...s, title: 'renamed' }));
    expect(store.sessions[0]!.title).toBe('renamed');
    const before = store.sessions;
    store.updateSession('missing', (s) => ({ ...s, title: 'nope' }));
    expect(store.sessions.map((s) => s.id)).toEqual(['a']);
    expect(store.sessions).not.toBe(before);
  });

  it('upserts sorted by recency and dedupes by id', () => {
    const store = sessionsStore();
    store.setSessions([
      makeSession('new', '2026-01-03T00:00:00.000Z'),
      makeSession('old', '2026-01-01T00:00:00.000Z'),
    ]);
    // Lands in the middle by timestamp alone (never forced to the front).
    store.upsertSessionSorted(makeSession('mid', '2026-01-02T00:00:00.000Z'));
    expect(store.sessions.map((s) => s.id)).toEqual(['new', 'mid', 'old']);
    // Same id replaces in place (re-sorted by the new timestamp).
    store.upsertSessionSorted(makeSession('old', '2026-01-04T00:00:00.000Z'));
    expect(store.sessions.map((s) => s.id)).toEqual(['old', 'new', 'mid']);
  });

  it('appends to the end and removes by id', () => {
    const store = sessionsStore();
    store.setSessions([makeSession('a', '2026-01-02T00:00:00.000Z')]);
    store.appendSession(makeSession('deep', '2026-01-01T00:00:00.000Z'));
    expect(store.sessions.map((s) => s.id)).toEqual(['a', 'deep']);
    store.removeSession('a');
    expect(store.sessions.map((s) => s.id)).toEqual(['deep']);
  });

  it('sets and clears the active session id', () => {
    const store = sessionsStore();
    store.setActiveSessionId('a');
    expect(store.activeSessionId).toBe('a');
    store.setActiveSessionId(undefined);
    expect(store.activeSessionId).toBeUndefined();
  });
});

describe('sessionsStore (pins)', () => {
  it('pins to the end of the section and persists', () => {
    const store = sessionsStore();
    store.pinSession('a');
    store.pinSession('b');
    expect(store.pinnedSessionIds).toEqual(['a', 'b']);
    expect(loadPinnedSessions()).toEqual(['a', 'b']);
  });

  it('pinning twice is a no-op', () => {
    const store = sessionsStore();
    store.pinSession('a');
    store.pinSession('a');
    expect(store.pinnedSessionIds).toEqual(['a']);
  });

  it('unpins singly, in batch, and via toggle', () => {
    const store = sessionsStore();
    store.pinSession('a');
    store.pinSession('b');
    store.pinSession('c');
    store.unpinSession('b');
    expect(store.pinnedSessionIds).toEqual(['a', 'c']);
    store.unpinSessions(['a', 'missing']);
    expect(store.pinnedSessionIds).toEqual(['c']);
    store.togglePinSession('c');
    expect(store.pinnedSessionIds).toEqual([]);
    store.togglePinSession('a');
    expect(store.pinnedSessionIds).toEqual(['a']);
    expect(loadPinnedSessions()).toEqual(['a']);
  });
});

describe('facade bridge (rawState accessors → store)', () => {
  const clientApiMock: Record<string, unknown> = {};

  beforeEach(() => {
    setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
    // The facade unconditionally hosts the main transcript pool; stub the
    // connection + baseline fetch it activates on session selection.
    clientApiMock.connectEvents = vi.fn(() => ({
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      health: () => ({ connected: false, open: false, stale: false }),
      close: vi.fn(),
    }));
    clientApiMock.getSessionTranscript = vi.fn().mockRejectedValue(new Error('no transcript'));
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('facade view computeds track store state (read direction)', async () => {
    vi.resetModules();
    // Re-import through the fresh module graph so the facade and the store
    // share the same package-held pinia instance.
    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { sessionsStore: freshSessionsStore } = await import('../src/stores/sessions');
    const client = useKimiWebClient();

    expect(client.sessions.value).toEqual([]);
    expect(client.activeSessionId.value).toBe('');

    freshSessionsStore().setSessions([makeSession('a', '2026-01-01T00:00:00.000Z')]);
    freshSessionsStore().setActiveSessionId('a');

    expect(client.sessions.value.map((s) => s.id)).toEqual(['a']);
    expect(client.activeSessionId.value).toBe('a');
  });

  it('facade actions write through to the store (write direction)', async () => {
    vi.resetModules();
    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { sessionsStore: freshSessionsStore } = await import('../src/stores/sessions');
    const client = useKimiWebClient();

    clientApiMock.updateSession = vi.fn().mockResolvedValue({});
    freshSessionsStore().setSessions([makeSession('a', '2026-01-01T00:00:00.000Z')]);

    await client.renameSession('a', 'new title');
    expect(freshSessionsStore().sessions[0]!.title).toBe('new title');

    client.pinSession('a');
    expect(freshSessionsStore().pinnedSessionIds).toEqual(['a']);
    client.togglePinSession('a');
    expect(freshSessionsStore().pinnedSessionIds).toEqual([]);
  });
});
