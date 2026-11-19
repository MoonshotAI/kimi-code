import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadDefaultOpenInTarget,
  resolveOpenInTarget,
  resolvePreferredOpenInTarget,
  saveDefaultOpenInTarget,
  useDefaultOpenInTarget,
} from '../src/lib/openInTarget';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

const globalRef = globalThis as { localStorage?: unknown };
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
  if (originalLocalStorage === undefined) delete globalRef.localStorage;
  else globalRef.localStorage = originalLocalStorage;
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

describe('resolvePreferredOpenInTarget', () => {
  const htmlCatalog = [
    { id: 'chrome', preferred: true },
    { id: 'safari', preferred: true },
    { id: 'vscode' },
    { id: 'finder' },
  ];

  it('defaults to the first preferred entry instead of a global default outside the group', () => {
    expect(resolvePreferredOpenInTarget(htmlCatalog, null, 'vscode')).toBe('chrome');
    expect(resolvePreferredOpenInTarget(htmlCatalog, null, null)).toBe('chrome');
  });

  it('keeps a global default that falls inside the preferred group', () => {
    expect(resolvePreferredOpenInTarget(htmlCatalog, null, 'safari')).toBe('safari');
  });

  it('keeps an explicit session choice from anywhere in the catalog', () => {
    expect(resolvePreferredOpenInTarget(htmlCatalog, 'vscode', null)).toBe('vscode');
    expect(resolvePreferredOpenInTarget(htmlCatalog, 'safari', 'vscode')).toBe('safari');
  });

  it('ignores a session choice that is no longer in the catalog', () => {
    expect(resolvePreferredOpenInTarget(htmlCatalog, 'cursor', 'vscode')).toBe('chrome');
  });

  it('falls back to the plain resolution when no entry is preferred', () => {
    const plain = [{ id: 'vscode' }, { id: 'zed' }];
    expect(resolvePreferredOpenInTarget(plain, null, 'zed')).toBe('zed');
    expect(resolvePreferredOpenInTarget(plain, null, null)).toBe('vscode');
  });

  it('returns null with an empty catalog', () => {
    expect(resolvePreferredOpenInTarget([], null, 'vscode')).toBeNull();
  });
});
