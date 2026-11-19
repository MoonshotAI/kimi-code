
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

beforeEach(() => {
  memStorage.clear();
});
import {
  loadPermissionBySession,
  loadStickyPermissionAt,
  permissionModeFromConfig,
  savePermissionBySession,
  saveStickyPermissionAt,
  STORAGE_KEYS,
} from '@moonshot-ai/app-core/lib';

describe('permissionModeFromConfig', () => {
  it('passes through every known mode', () => {
    expect(permissionModeFromConfig('manual')).toBe('manual');
    expect(permissionModeFromConfig('auto')).toBe('auto');
    expect(permissionModeFromConfig('yolo')).toBe('yolo');
  });

  it('falls through for an unset config', () => {
    expect(permissionModeFromConfig(undefined)).toBeUndefined();
    expect(permissionModeFromConfig(null)).toBeUndefined();
  });

  it('falls through for values this build does not recognize', () => {
    expect(permissionModeFromConfig('turbo')).toBeUndefined();
    expect(permissionModeFromConfig('')).toBeUndefined();
    expect(permissionModeFromConfig({ mode: 'yolo' })).toBeUndefined();
    expect(permissionModeFromConfig(0)).toBeUndefined();
  });
});

describe('per-session map persistence', () => {
  it('round-trips the map and drops entries this build does not recognize', () => {
    savePermissionBySession({ s1: 'yolo' });
    expect(loadPermissionBySession()).toEqual({ s1: 'yolo' });
    localStorage.setItem(
      STORAGE_KEYS.permissionBySession,
      JSON.stringify({ s1: 'turbo', s2: 'auto' }),
    );
    expect(loadPermissionBySession()).toEqual({ s2: 'auto' });
    localStorage.setItem(STORAGE_KEYS.permissionBySession, 'not json');
    expect(loadPermissionBySession()).toEqual({});
    localStorage.removeItem(STORAGE_KEYS.permissionBySession);
    expect(loadPermissionBySession()).toEqual({});
  });

  it('round-trips the sticky-pick timestamp, defaulting to 0', () => {
    expect(loadStickyPermissionAt()).toBe(0);
    saveStickyPermissionAt(1720000000000);
    expect(loadStickyPermissionAt()).toBe(1720000000000);
    localStorage.setItem(STORAGE_KEYS.permissionStickyAt, 'garbage');
    expect(loadStickyPermissionAt()).toBe(0);
  });
});
