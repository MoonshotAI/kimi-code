import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadCollapsedWorkspaces,
  loadUnread,
  loadWorkspaceOrder,
  saveCollapsedWorkspaces,
  saveUnread,
  saveWorkspaceOrder,
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
    expect(STORAGE_KEYS.notifyOnQuestion).toBe('kimi-web.notify-on-question');
    expect(STORAGE_KEYS.soundOnComplete).toBe('kimi-web.sound-on-complete');
    expect(STORAGE_KEYS.locale).toBe('kimi-locale');
  });
});

describe('loadUnread / saveUnread', () => {
  it('returns an empty map when the key is missing', () => {
    expect(loadUnread()).toEqual({});
  });

  it('keeps only true entries', () => {
    safeSetString(STORAGE_KEYS.unread, JSON.stringify({ B: true, C: false, D: 'yes' }));
    expect(loadUnread()).toEqual({ B: true });
  });

  it('drops false entries, clearing the unread dot', () => {
    saveUnread({ B: true, C: true });
    saveUnread({ B: false });
    expect(loadUnread()).toEqual({ C: true });
  });

  it('merges with the latest stored value so a clear from another tab is not overwritten', () => {
    // This tab marks B unread.
    saveUnread({ B: true });
    expect(loadUnread()).toEqual({ B: true });

    // Another tab clears B and marks C (simulated by writing the key directly).
    safeSetString(STORAGE_KEYS.unread, JSON.stringify({ C: true }));

    // This tab marks D unread, passing only the change (not a full, stale map).
    saveUnread({ D: true });

    // B must NOT come back — it was cleared by the other tab.
    expect(loadUnread()).toEqual({ C: true, D: true });
  });
});

describe('loadCollapsedWorkspaces / saveCollapsedWorkspaces', () => {
  it('returns an empty array when the key is missing', () => {
    expect(loadCollapsedWorkspaces()).toEqual([]);
  });

  it('round-trips the collapsed ids', () => {
    saveCollapsedWorkspaces(['ws-1', 'ws-2']);
    expect(loadCollapsedWorkspaces()).toEqual(['ws-1', 'ws-2']);
  });

  it('accepts any iterable of ids', () => {
    saveCollapsedWorkspaces(new Set(['ws-1', 'ws-3']));
    expect(loadCollapsedWorkspaces()).toEqual(['ws-1', 'ws-3']);
  });

  it('drops non-string entries and returns [] for malformed values', () => {
    safeSetString(STORAGE_KEYS.collapsedWorkspaces, JSON.stringify(['ws-1', 2, null, 'ws-2']));
    expect(loadCollapsedWorkspaces()).toEqual(['ws-1', 'ws-2']);

    safeSetString(STORAGE_KEYS.collapsedWorkspaces, JSON.stringify({ ws: true }));
    expect(loadCollapsedWorkspaces()).toEqual([]);
  });
});

describe('loadWorkspaceOrder / saveWorkspaceOrder', () => {
  it('returns an empty array when the key is missing', () => {
    expect(loadWorkspaceOrder()).toEqual([]);
  });

  it('round-trips the ordered ids', () => {
    saveWorkspaceOrder(['ws-2', 'ws-1']);
    expect(loadWorkspaceOrder()).toEqual(['ws-2', 'ws-1']);
  });

  it('accepts any iterable of ids', () => {
    saveWorkspaceOrder(new Set(['ws-3', 'ws-1']));
    expect(loadWorkspaceOrder()).toEqual(['ws-3', 'ws-1']);
  });

  it('drops non-string entries and returns [] for malformed values', () => {
    safeSetString(STORAGE_KEYS.workspaceOrder, JSON.stringify(['ws-1', 2, null]));
    expect(loadWorkspaceOrder()).toEqual(['ws-1']);

    safeSetString(STORAGE_KEYS.workspaceOrder, JSON.stringify({ ws: true }));
    expect(loadWorkspaceOrder()).toEqual([]);
  });
});
