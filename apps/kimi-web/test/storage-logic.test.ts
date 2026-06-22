import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STORAGE_KEYS,
  draftStorageKey,
  safeGetJson,
  safeGetString,
  safeRemove,
  safeSetJson,
  safeSetString,
} from '../src/lib/storage';

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

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

let backing: Storage;

beforeEach(() => {
  backing = createMemoryStorage();
  installStorage(backing);
});

afterEach(() => {
  installStorage(createMemoryStorage());
});

describe('safeGetString / safeSetString', () => {
  it('round-trips a value', () => {
    safeSetString('k', 'hello');
    expect(safeGetString('k')).toBe('hello');
  });

  it('returns null for a missing key', () => {
    expect(safeGetString('missing')).toBeNull();
  });

  it('overwrites an existing value', () => {
    safeSetString('k', 'a');
    safeSetString('k', 'b');
    expect(safeGetString('k')).toBe('b');
  });
});

describe('safeRemove', () => {
  it('removes an existing key', () => {
    safeSetString('k', 'v');
    safeRemove('k');
    expect(safeGetString('k')).toBeNull();
  });

  it('is a no-op for a missing key', () => {
    expect(() => safeRemove('missing')).not.toThrow();
  });
});

describe('safeGetJson / safeSetJson', () => {
  it('round-trips a JSON value', () => {
    safeSetJson('k', { a: 1, b: [2, 3] });
    expect(safeGetJson('k')).toEqual({ a: 1, b: [2, 3] });
  });

  it('returns null for a missing key', () => {
    expect(safeGetJson('missing')).toBeNull();
  });

  it('returns null when the stored value is not valid JSON', () => {
    safeSetString('k', '{not json');
    expect(safeGetJson('k')).toBeNull();
  });
});

describe('error swallowing', () => {
  it('safeGetString returns null when storage throws', () => {
    const throwing = createMemoryStorage();
    throwing.getItem = () => {
      throw new Error('denied');
    };
    installStorage(throwing);
    expect(safeGetString('k')).toBeNull();
  });

  it('safeSetString does not throw when storage throws', () => {
    const throwing = createMemoryStorage();
    throwing.setItem = () => {
      throw new Error('quota');
    };
    installStorage(throwing);
    expect(() => safeSetString('k', 'v')).not.toThrow();
  });
});

describe('draftStorageKey', () => {
  it('uses the session id when present', () => {
    expect(draftStorageKey('abc')).toBe('kimi-web.draft.abc');
  });

  it('falls back to __new__ when sid is empty/undefined', () => {
    expect(draftStorageKey(undefined)).toBe('kimi-web.draft.__new__');
    expect(draftStorageKey('')).toBe('kimi-web.draft.__new__');
  });
});

describe('STORAGE_KEYS', () => {
  it('keeps the legacy key strings unchanged', () => {
    expect(STORAGE_KEYS.theme).toBe('kimi-web.theme');
    expect(STORAGE_KEYS.activeWorkspace).toBe('kimi-active-workspace');
    expect(STORAGE_KEYS.notifyOnComplete).toBe('kimi-web.notify-on-complete');
    expect(STORAGE_KEYS.locale).toBe('kimi-locale');
  });
});
