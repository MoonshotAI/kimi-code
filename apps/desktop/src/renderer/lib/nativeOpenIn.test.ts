// apps/desktop/src/renderer/lib/nativeOpenIn.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canOpenInNative,
  listNativeOpenInApps,
  loadDefaultOpenInTarget,
  openInNativeApp,
  resolveOpenInTarget,
  saveDefaultOpenInTarget,
  useDefaultOpenInTarget,
} from './nativeOpenIn';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

// Renderer tests run in the node environment, so there is no real `window`
// or `localStorage`; each test installs just enough of both to stand in for
// the preload bridge and persisted preferences.
const globalRef = globalThis as { window?: unknown; localStorage?: unknown };
const originalWindow = globalRef.window;
const originalLocalStorage = globalRef.localStorage;

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  globalRef.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

afterEach(() => {
  if (originalWindow === undefined) delete globalRef.window;
  else globalRef.window = originalWindow;
  if (originalLocalStorage === undefined) delete globalRef.localStorage;
  else globalRef.localStorage = originalLocalStorage;
});

function setBridge(bridge: unknown): void {
  globalRef.window = bridge === undefined ? {} : { kimiDesktop: bridge };
}

const FULL_BRIDGE = {
  listOpenInApps: async () => [
    { id: 'vscode', label: 'VS Code' },
    { id: 'ghostty', label: 'Ghostty' },
  ],
  openInApp: async () => ({ ok: true }),
};

describe('canOpenInNative', () => {
  it('is false when the desktop bridge is absent (not running in Electron)', () => {
    setBridge(undefined);
    expect(canOpenInNative()).toBe(false);
  });

  it('is false when the bridge lacks the open-in methods (old preload)', () => {
    setBridge({ showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
    expect(canOpenInNative()).toBe(false);
  });

  it('is true when both open-in methods are exposed', () => {
    setBridge(FULL_BRIDGE);
    expect(canOpenInNative()).toBe(true);
  });
});

describe('listNativeOpenInApps', () => {
  it('returns [] when the bridge is absent', async () => {
    setBridge(undefined);
    expect(await listNativeOpenInApps()).toEqual([]);
  });

  it('returns the catalog from the main process', async () => {
    setBridge(FULL_BRIDGE);
    expect(await listNativeOpenInApps()).toEqual([
      { id: 'vscode', label: 'VS Code' },
      { id: 'ghostty', label: 'Ghostty' },
    ]);
  });

  it('returns [] when the IPC call rejects', async () => {
    setBridge({ ...FULL_BRIDGE, listOpenInApps: async () => Promise.reject(new Error('ipc down')) });
    expect(await listNativeOpenInApps()).toEqual([]);
  });

  it('drops malformed entries from a non-conforming payload', async () => {
    setBridge({
      ...FULL_BRIDGE,
      listOpenInApps: async () => [{ id: 'zed', label: 'Zed' }, { id: 1 }, null, 'x'],
    });
    expect(await listNativeOpenInApps()).toEqual([{ id: 'zed', label: 'Zed' }]);
  });
});

describe('openInNativeApp', () => {
  it('is false when the bridge is absent', async () => {
    setBridge(undefined);
    expect(await openInNativeApp('vscode', '/work/dir')).toBe(false);
  });

  it('forwards app id and path to the main process', async () => {
    const openInApp = vi.fn().mockResolvedValue({ ok: true });
    setBridge({ ...FULL_BRIDGE, openInApp });
    expect(await openInNativeApp('ghostty', '/work/dir')).toBe(true);
    expect(openInApp).toHaveBeenCalledWith('ghostty', '/work/dir');
  });

  it('is false when the main process reports a failure', async () => {
    setBridge({ ...FULL_BRIDGE, openInApp: async () => ({ ok: false, error: 'not installed' }) });
    expect(await openInNativeApp('cursor', '/work/dir')).toBe(false);
  });

  it('is false when the IPC call rejects', async () => {
    setBridge({ ...FULL_BRIDGE, openInApp: async () => Promise.reject(new Error('ipc down')) });
    expect(await openInNativeApp('ghostty', '/work/dir')).toBe(false);
  });
});

describe('default target persistence', () => {
  it('round-trips the settings choice', () => {
    expect(loadDefaultOpenInTarget()).toBeNull();
    saveDefaultOpenInTarget('ghostty');
    expect(loadDefaultOpenInTarget()).toBe('ghostty');
  });

  it('clears back to auto when saved as an empty string', () => {
    saveDefaultOpenInTarget('ghostty');
    saveDefaultOpenInTarget('');
    expect(loadDefaultOpenInTarget()).toBeNull();
    expect(store.has(STORAGE_KEYS.openInDefaultTarget)).toBe(false);
  });
});

describe('useDefaultOpenInTarget', () => {
  it('is a singleton reactive mirror of the persisted default', () => {
    expect(useDefaultOpenInTarget()).toBe(useDefaultOpenInTarget());
    saveDefaultOpenInTarget('zed');
    expect(useDefaultOpenInTarget().value).toBe('zed');
    saveDefaultOpenInTarget('');
    expect(useDefaultOpenInTarget().value).toBeNull();
  });
});

describe('resolveOpenInTarget', () => {
  it('returns the selected app when it is still installed', () => {
    expect(resolveOpenInTarget(['vscode', 'ghostty'], 'ghostty')).toBe('ghostty');
  });

  it('falls back to the first available app when nothing is selected', () => {
    expect(resolveOpenInTarget(['vscode', 'ghostty'], null)).toBe('vscode');
  });

  it('falls back to the first available app when the selection was uninstalled', () => {
    expect(resolveOpenInTarget(['vscode', 'ghostty'], 'cursor')).toBe('vscode');
  });

  it('returns null with an empty catalog', () => {
    expect(resolveOpenInTarget([], null)).toBeNull();
    expect(resolveOpenInTarget([], 'vscode')).toBeNull();
  });
});
