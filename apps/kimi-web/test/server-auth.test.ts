// apps/kimi-web/test/server-auth.test.ts
// Credential store for the server bearer token: expiring localStorage
// persistence, one-time storage migration, fragment-token intake, and the
// markAuthRequired clearing path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'kimi-web.server-credential';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-12T00:00:00Z');

interface StoredCredential {
  version: 1;
  credential: string;
  expiresAt: number;
}

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys()).at(index) ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

let localStore: Storage;
let sessionStore: Storage;

function writeStoredCredential(
  credential: string,
  expiresAt = Date.now() + 7 * DAY_MS,
): void {
  localStore.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    credential,
    expiresAt,
  } satisfies StoredCredential));
}

function readStoredCredential(): StoredCredential | undefined {
  const raw = localStore.getItem(STORAGE_KEY);
  return raw === null ? undefined : JSON.parse(raw) as StoredCredential;
}

/** Fresh module instance per test — the store keeps module-level state. */
async function loadAuth() {
  vi.resetModules();
  return import('../src/api/daemon/serverAuth');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStore = createMemoryStorage();
  sessionStore = createMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStore });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStore });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

describe('credential persistence', () => {
  it('round-trips through localStorage across module reloads', async () => {
    const auth = await loadAuth();
    auth.setCredential('tok-1');
    expect(auth.getCredential()).toBe('tok-1');
    expect(readStoredCredential()).toEqual({
      version: 1,
      credential: 'tok-1',
      expiresAt: NOW + 7 * DAY_MS,
    });

    // Simulate a full page reload: fresh module state, same browser storage.
    const reloaded = await loadAuth();
    expect(reloaded.initServerAuth()).toBe(true);
    expect(reloaded.getCredential()).toBe('tok-1');
  });

  it('expires 7 days after write without extending on reads', async () => {
    const auth = await loadAuth();
    auth.setCredential('tok-1');

    vi.setSystemTime(NOW + 6 * DAY_MS);
    const beforeExpiry = await loadAuth();
    expect(beforeExpiry.initServerAuth()).toBe(true);
    expect(readStoredCredential()?.expiresAt).toBe(NOW + 7 * DAY_MS);

    vi.setSystemTime(NOW + 7 * DAY_MS);
    const expired = await loadAuth();
    expect(expired.initServerAuth()).toBe(false);
    expect(expired.getCredential()).toBeUndefined();
    expect(localStore.getItem(STORAGE_KEY)).toBeNull();
  });

  it('stops using an in-memory credential when its 7 days expire', async () => {
    const auth = await loadAuth();
    auth.setCredential('tok-1');

    vi.setSystemTime(NOW + 7 * DAY_MS);
    expect(auth.getCredential()).toBeUndefined();
    expect(localStore.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clearCredential drops the persisted copy', async () => {
    const auth = await loadAuth();
    auth.setCredential('tok-1');
    auth.clearCredential();
    expect(auth.getCredential()).toBeUndefined();
    expect(localStore.getItem(STORAGE_KEY)).toBeNull();
  });

  it('adopts a legacy sessionStorage credential into localStorage', async () => {
    sessionStore.setItem(STORAGE_KEY, 'legacy-tok');
    const auth = await loadAuth();
    expect(auth.initServerAuth()).toBe(true);
    expect(auth.getCredential()).toBe('legacy-tok');
    expect(readStoredCredential()).toEqual({
      version: 1,
      credential: 'legacy-tok',
      expiresAt: NOW + 7 * DAY_MS,
    });
    expect(sessionStore.getItem(STORAGE_KEY)).toBeNull();
  });

  it('adds an expiry to a credential stored by the earlier localStorage format', async () => {
    localStore.setItem(STORAGE_KEY, 'legacy-local-tok');
    const auth = await loadAuth();

    expect(auth.initServerAuth()).toBe(true);
    expect(auth.getCredential()).toBe('legacy-local-tok');
    expect(readStoredCredential()).toEqual({
      version: 1,
      credential: 'legacy-local-tok',
      expiresAt: NOW + 7 * DAY_MS,
    });
  });

  it('keeps using a legacy session credential when localStorage migration fails', async () => {
    sessionStore.setItem(STORAGE_KEY, 'legacy-tok');
    localStore.setItem = () => {
      throw new Error('quota exceeded');
    };
    const auth = await loadAuth();

    expect(auth.initServerAuth()).toBe(true);
    expect(auth.getCredential()).toBe('legacy-tok');
    expect(sessionStore.getItem(STORAGE_KEY)).toBeNull();

    const reloaded = await loadAuth();
    expect(reloaded.initServerAuth()).toBe(false);
  });

  it('does not grant a fresh window on reload when legacy local migration fails', async () => {
    localStore.setItem(STORAGE_KEY, 'legacy-local-tok');
    localStore.setItem = () => {
      throw new Error('quota exceeded');
    };
    const auth = await loadAuth();

    expect(auth.initServerAuth()).toBe(true);
    expect(auth.getCredential()).toBe('legacy-local-tok');
    expect(localStore.getItem(STORAGE_KEY)).toBeNull();

    const reloaded = await loadAuth();
    expect(reloaded.initServerAuth()).toBe(false);
  });

  it('does not revive an expired credential from legacy sessionStorage', async () => {
    writeStoredCredential('expired-tok', NOW);
    sessionStore.setItem(STORAGE_KEY, 'expired-tok');
    const auth = await loadAuth();

    expect(auth.initServerAuth()).toBe(false);
    expect(auth.getCredential()).toBeUndefined();
    expect(localStore.getItem(STORAGE_KEY)).toBeNull();
    expect(sessionStore.getItem(STORAGE_KEY)).toBeNull();
  });

  it('keeps an expired record when legacy session cleanup fails', async () => {
    writeStoredCredential('expired-tok', NOW);
    sessionStore.setItem(STORAGE_KEY, 'expired-tok');
    sessionStore.removeItem = () => {
      throw new Error('denied');
    };
    const auth = await loadAuth();

    expect(auth.initServerAuth()).toBe(false);
    expect(localStore.getItem(STORAGE_KEY)).not.toBeNull();

    const reloaded = await loadAuth();
    expect(reloaded.initServerAuth()).toBe(false);
  });

  it('setCredential removes any legacy sessionStorage copy', async () => {
    sessionStore.setItem(STORAGE_KEY, 'legacy-tok');
    const auth = await loadAuth();
    auth.setCredential('tok-2');
    expect(sessionStore.getItem(STORAGE_KEY)).toBeNull();
    expect(readStoredCredential()?.credential).toBe('tok-2');
  });

  it('removes the legacy sessionStorage copy even when localStorage is blocked', async () => {
    const blockedLocal = createMemoryStorage();
    blockedLocal.setItem = () => {
      throw new Error('denied');
    };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: blockedLocal });
    sessionStore.setItem(STORAGE_KEY, 'legacy-tok');

    const auth = await loadAuth();
    auth.setCredential('tok-new');

    // The credential lives in memory only, but the stale session copy must
    // not survive to be re-migrated on the next reload.
    expect(auth.getCredential()).toBe('tok-new');
    expect(sessionStore.getItem(STORAGE_KEY)).toBeNull();
  });

  it('keeps working in memory when storage throws', async () => {
    const throwing = createMemoryStorage();
    throwing.setItem = () => {
      throw new Error('denied');
    };
    throwing.getItem = () => {
      throw new Error('denied');
    };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: throwing });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: throwing });

    const auth = await loadAuth();
    expect(auth.initServerAuth()).toBe(false);
    auth.setCredential('tok-mem');
    expect(auth.getCredential()).toBe('tok-mem');
    expect(() => {
      auth.clearCredential();
    }).not.toThrow();
  });
});

describe('fragment token intake', () => {
  function installWindow(hash: string) {
    const replaceState = vi.fn();
    const win = {
      location: {
        hash,
        href: `http://localhost:58627/some/path?x=1${hash}`,
      },
      history: { state: null, replaceState },
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    return { replaceState };
  }

  it('prefers the fragment token, stores it, and scrubs the URL', async () => {
    writeStoredCredential('stored-tok');
    const { replaceState } = installWindow('#token=frag-tok');
    const auth = await loadAuth();

    expect(auth.initServerAuth()).toBe(true);
    expect(auth.getCredential()).toBe('frag-tok');
    expect(readStoredCredential()?.credential).toBe('frag-tok');
    // Fragment scrubbed: path + query kept, token gone.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/some/path?x=1');
  });

  it('ignores an empty fragment and falls back to storage', async () => {
    writeStoredCredential('stored-tok');
    installWindow('');
    const auth = await loadAuth();

    expect(auth.initServerAuth()).toBe(true);
    expect(auth.getCredential()).toBe('stored-tok');
  });
});

describe('markAuthRequired', () => {
  it('clears the credential and notifies listeners', async () => {
    const auth = await loadAuth();
    auth.setCredential('tok-1');
    const listener = vi.fn();
    const off = auth.onAuthRequired(listener);

    auth.markAuthRequired();
    expect(auth.getCredential()).toBeUndefined();
    expect(localStore.getItem(STORAGE_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    auth.markAuthRequired();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('cross-tab credential clearing', () => {
  it('keeps a newer same-token record when this tab’s in-memory copy expires', async () => {
    const auth = await loadAuth();
    auth.setCredential('tok-1');
    writeStoredCredential('tok-1', NOW + 8 * DAY_MS);
    const refreshedStored = localStore.getItem(STORAGE_KEY);

    vi.setSystemTime(NOW + 7 * DAY_MS);
    expect(auth.getCredential()).toBeUndefined();
    expect(localStore.getItem(STORAGE_KEY)).toBe(refreshedStored);
  });

  it('keeps a newer token another tab persisted when this tab is stale', async () => {
    const auth = await loadAuth();
    auth.setCredential('stale-tok');
    // Another tab stores a fresh token (e.g. after rotation + `kimi web`).
    writeStoredCredential('fresh-tok');
    const freshStored = localStore.getItem(STORAGE_KEY);

    auth.markAuthRequired();

    // This tab forgets its rejected credential and prompts…
    expect(auth.getCredential()).toBeUndefined();
    // …but the fresh shared token survives for reloads and other tabs.
    expect(localStore.getItem(STORAGE_KEY)).toBe(freshStored);
  });

  it('clears the persisted copy when it still matches the rejected credential', async () => {
    const auth = await loadAuth();
    auth.setCredential('tok-1');
    auth.markAuthRequired();
    expect(localStore.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clears the same rejected token even if another tab refreshed its expiry', async () => {
    const auth = await loadAuth();
    auth.setCredential('tok-1');
    writeStoredCredential('tok-1', NOW + 8 * DAY_MS);

    auth.markAuthRequired();

    expect(auth.getCredential()).toBeUndefined();
    expect(localStore.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not clear another tab’s token when this tab had no credential', async () => {
    writeStoredCredential('fresh-tok');
    const freshStored = localStore.getItem(STORAGE_KEY);
    const auth = await loadAuth();
    auth.markAuthRequired();
    expect(localStore.getItem(STORAGE_KEY)).toBe(freshStored);
  });
});
