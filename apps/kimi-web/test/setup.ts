// apps/kimi-web/test/setup.ts
//
// Node 24 exposes an experimental global localStorage that is unavailable
// unless Node is started with --localstorage-file. The app and tests expect
// browser-like storage, so pin the globals to jsdom storage when available and
// fall back to a tiny in-memory implementation otherwise.

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

function usableStorage(storage: Storage | undefined): Storage {
  if (!storage) return createMemoryStorage();
  try {
    const key = '__kimi_web_test_storage__';
    storage.setItem(key, '1');
    storage.removeItem(key);
    return storage;
  } catch {
    return createMemoryStorage();
  }
}

function defineStorage(name: 'localStorage' | 'sessionStorage', storage: Storage): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: storage,
  });
  if (typeof window !== 'undefined') {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        value: storage,
      });
    } catch {
      // Some jsdom/browser-like environments expose storage as non-configurable.
    }
  }
}

function readWindowStorage(name: 'localStorage' | 'sessionStorage'): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window[name];
  } catch {
    return undefined;
  }
}

defineStorage('localStorage', usableStorage(readWindowStorage('localStorage')));
defineStorage('sessionStorage', usableStorage(readWindowStorage('sessionStorage')));
