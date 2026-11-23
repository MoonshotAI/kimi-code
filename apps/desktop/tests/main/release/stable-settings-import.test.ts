import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canImportStableSettings,
  consumeImportMarker,
  consumePendingStableImport,
  isStableAppRunning,
  performStableSettingsImport,
  stableSettingsPrecheck,
  stableUserDataDir,
  writeImportMarker,
} from '../../../src/main/release/stable-settings-import';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kimi-stable-import-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedLeveldb(dir: string, marker: string): void {
  const leveldb = join(dir, 'Local Storage', 'leveldb');
  mkdirSync(leveldb, { recursive: true });
  writeFileSync(join(leveldb, 'CURRENT'), marker, 'utf8');
}

describe('canImportStableSettings', () => {
  it('requires a canary version on darwin', () => {
    expect(canImportStableSettings('0.0.20-canary.12', 'darwin')).toBe(true);
    expect(canImportStableSettings('0.0.20', 'darwin')).toBe(false);
    expect(canImportStableSettings('0.0.20-canary.12', 'win32')).toBe(false);
    expect(canImportStableSettings('0.0.20-canary.12', 'linux')).toBe(false);
  });
});

describe('isStableAppRunning', () => {
  it('maps pgrep exit codes (0 running, 1 not running, anything else fail-safe running)', () => {
    expect(isStableAppRunning(() => '')).toBe(true);
    expect(
      isStableAppRunning(() => {
        throw Object.assign(new Error('exit 1'), { status: 1 });
      }),
    ).toBe(false);
    expect(
      isStableAppRunning(() => {
        throw new Error('pgrep missing');
      }),
    ).toBe(true);
  });
});

describe('stableSettingsPrecheck', () => {
  it('gates on identity, stable data, and the stable process in order', () => {
    const appData = join(root, 'appData');
    expect(stableSettingsPrecheck('0.0.20', 'darwin', appData, () => '')).toBe('unavailable');
    expect(stableSettingsPrecheck('0.0.20-canary.1', 'darwin', appData, () => '')).toBe('no-stable-data');
    seedLeveldb(stableUserDataDir(appData), 'stable');
    expect(stableSettingsPrecheck('0.0.20-canary.1', 'darwin', appData, () => '')).toBe('stable-running');
    expect(
      stableSettingsPrecheck('0.0.20-canary.1', 'darwin', appData, () => {
        throw Object.assign(new Error('exit 1'), { status: 1 });
      }),
    ).toBe('ok');
  });
});

describe('import marker', () => {
  it('write → consume returns the marker and deletes the file', () => {
    const userData = join(root, 'canary');
    mkdirSync(userData, { recursive: true });
    writeImportMarker(userData, '/stable/userdata');
    const marker = consumeImportMarker(userData);
    expect(marker?.sourceDir).toBe('/stable/userdata');
    expect(consumeImportMarker(userData)).toBeNull();
  });

  it('missing or corrupt markers read as null (and corrupt ones get removed)', () => {
    const userData = join(root, 'canary');
    mkdirSync(userData, { recursive: true });
    expect(consumeImportMarker(userData)).toBeNull();
    writeFileSync(join(userData, '.stable-ui-settings-import.json'), 'not json', 'utf8');
    expect(consumeImportMarker(userData)).toBeNull();
    expect(existsSync(join(userData, '.stable-ui-settings-import.json'))).toBe(false);
    writeFileSync(join(userData, '.stable-ui-settings-import.json'), '{}', 'utf8');
    expect(consumeImportMarker(userData)).toBeNull();
  });
});

describe('performStableSettingsImport', () => {
  it('copies the stable leveldb into an empty profile', () => {
    const stable = join(root, 'stable');
    const canary = join(root, 'canary');
    seedLeveldb(stable, 'stable-current');
    const outcome = performStableSettingsImport(canary, stable);
    expect(outcome).toEqual({ ok: true, backedUp: false });
    expect(readFileSync(join(canary, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8')).toBe('stable-current');
  });

  it('backs up the existing leveldb (rolling single .bak) before overwriting', () => {
    const stable = join(root, 'stable');
    const canary = join(root, 'canary');
    seedLeveldb(stable, 'stable-v2');
    seedLeveldb(canary, 'canary-v1');
    const first = performStableSettingsImport(canary, stable);
    expect(first).toEqual({ ok: true, backedUp: true });
    expect(readFileSync(join(canary, 'Local Storage', 'leveldb.bak', 'CURRENT'), 'utf8')).toBe('canary-v1');
    expect(readFileSync(join(canary, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8')).toBe('stable-v2');

    seedLeveldb(stable, 'stable-v3');
    const second = performStableSettingsImport(canary, stable);
    expect(second.backedUp).toBe(true);
    expect(readFileSync(join(canary, 'Local Storage', 'leveldb.bak', 'CURRENT'), 'utf8')).toBe('stable-v2');
    expect(readFileSync(join(canary, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8')).toBe('stable-v3');
  });

  it('reports a missing stable source without touching the destination', () => {
    const canary = join(root, 'canary');
    seedLeveldb(canary, 'canary-v1');
    const outcome = performStableSettingsImport(canary, join(root, 'nonexistent'));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not found');
    expect(readFileSync(join(canary, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8')).toBe('canary-v1');
  });
});

describe('consumePendingStableImport', () => {
  it('is a no-op without a marker', () => {
    const info = vi.fn();
    const warn = vi.fn();
    consumePendingStableImport(join(root, 'canary'), { info, warn });
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('consumes the marker and imports when the stable app is not running', () => {
    const stable = join(root, 'stable');
    const canary = join(root, 'canary');
    mkdirSync(canary, { recursive: true });
    seedLeveldb(stable, 'stable-current');
    writeImportMarker(canary, stable);

    const info = vi.fn();
    const warn = vi.fn();
    consumePendingStableImport(canary, { info, warn }, () => {
      throw Object.assign(new Error('exit 1'), { status: 1 });
    });
    expect(info).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(readFileSync(join(canary, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8')).toBe('stable-current');
    expect(consumeImportMarker(canary)).toBeNull();
  });

  it('skips the import (marker consumed, warning logged) when the stable app is running', () => {
    const stable = join(root, 'stable');
    const canary = join(root, 'canary');
    mkdirSync(canary, { recursive: true });
    seedLeveldb(stable, 'stable-current');
    writeImportMarker(canary, stable);

    const info = vi.fn();
    const warn = vi.fn();
    consumePendingStableImport(canary, { info, warn }, () => '123');
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(existsSync(join(canary, 'Local Storage', 'leveldb'))).toBe(false);
    expect(consumeImportMarker(canary)).toBeNull();
  });
});
