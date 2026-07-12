// apps/kimi-web/test/server-auth.test.ts
// Credential store for the server bearer token: localStorage persistence,
// one-time sessionStorage migration, fragment-token intake, and the
// markAuthRequired clearing path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'kimi-web.server-credential';

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
      data.set(key, String(value));
    },
  };
}

let localStore: Storage;
let sessionStore: Storage;

/** Fresh module instance per test — the store keeps module-level state. */
async function loadAuth() {
  vi.resetModules();
  return await import('../src/api/daemon/serverAuth');
}

beforeEach(() => {
  localStore = createMemoryStorage();
  sessionStore = createMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStore });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStore });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('credential persistence', () => {
  it('round-trips through localStorage across module reloads', async () => {
    const auth = await loadAuth();
    auth.setCredential('tok-1');
    expect(auth.getCredential()).toBe('tok-1');
    expect(localStore.getItem(STORAGE_KEY)).toBe('tok-1');

    // Simulate a full page reload: fresh module state, same browser storage.
    const reloaded = await loadAuth();
    expect(reloaded.initServerAuth()).toBe(true);
    expect(reloaded.getCredential()).toBe('tok-1');
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
    expect(localStore.getItem(STORAGE_KEY)).toBe('legacy-tok');
    expect(sessionStore.getItem(STORAGE_KEY)).toBeNull();
  });

  it('setCredential removes any legacy sessionStorage copy', async () => {
    sessionStore.setItem(STORAGE_KEY, 'legacy-tok');
    const auth = await loadAuth();
    auth.setCredential('tok-2');
    expect(sessionStore.getItem(STORAGE_KEY)).toBeNull();
    expect(localStore.getItem(STORAGE_KEY)).toBe('tok-2');
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
    expect(() => auth.clearCredential()).not.toThrow();
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
    localStore.setItem(STORAGE_KEY, 'stored-tok');
    const { replaceState } = installWindow('#token=frag-tok');
    const auth = await loadAuth();

    expect(auth.initServerAuth()).toBe(true);
    expect(auth.getCredential()).toBe('frag-tok');
    expect(localStore.getItem(STORAGE_KEY)).toBe('frag-tok');
    // Fragment scrubbed: path + query kept, token gone.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/some/path?x=1');
  });

  it('ignores an empty fragment and falls back to storage', async () => {
    localStore.setItem(STORAGE_KEY, 'stored-tok');
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
