import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

import {
  getEmbeddedNativeAssetManifest,
  getNativePackageRoot,
  getSqliteNativeBinding,
  type NativeAssetManifest,
} from './native-assets';

const smokePackages = ['@mariozechner/clipboard', '@moonshot-ai/pi-tui', 'better-sqlite3'];

function smokePiTuiNativeLoad(): void {
  const platform = process.platform;
  const arch = process.arch;
  let rel: string | undefined;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'darwin', 'prebuilds', `darwin-${arch}`, 'darwin-platform.node');
  } else if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'linux', 'prebuilds', `linux-${arch}`, 'linux-platform-x11.node');
  } else if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'win32', 'prebuilds', `win32-${arch}`, 'win32-platform.node');
  }
  if (rel === undefined) return;

  const req = createRequire(import.meta.url);
  const helper = req(join(dirname(process.execPath), rel)) as {
    getText?: unknown;
    getImage?: unknown;
  };
  if (typeof helper.getText !== 'function' || typeof helper.getImage !== 'function') {
    throw new TypeError(`pi-tui native helper exports are unexpected: ${rel}`);
  }
}

function smokeSqlite(manifest: NativeAssetManifest): void {
  const nativeBinding = getSqliteNativeBinding({ manifest });
  if (nativeBinding === null || process.env['KIMI_CODE_SQLITE_NATIVE_BINDING'] !== nativeBinding) {
    throw new Error('SQLite native binding was not resolved from the embedded manifest.');
  }

  const dir = mkdtempSync(join(tmpdir(), 'kimi-sqlite-native-smoke-'));
  try {
    const db = new Database(join(dir, 'smoke.sqlite'), { nativeBinding });
    try {
      db.exec('CREATE TABLE native_smoke (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');
      db.prepare('INSERT INTO native_smoke (id, value) VALUES (?, ?)').run('kimi', 42);
      const row = db
        .prepare('SELECT value, sqlite_version() AS version FROM native_smoke WHERE id = ?')
        .get('kimi') as { value: number; version: string } | undefined;
      if (row?.value !== 42) throw new Error(`SQLite readback mismatch: ${JSON.stringify(row)}`);
      process.stdout.write(`SQLite native smoke passed: ${row.version} (${nativeBinding})\n`);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runSmoke(): void {
  const manifest = getEmbeddedNativeAssetManifest();
  if (manifest === null) throw new Error('Native asset manifest is not available.');
  for (const packageName of smokePackages) {
    if (getNativePackageRoot(packageName, { manifest }) === null) {
      throw new Error(`Native package is not available: ${packageName}`);
    }
  }
  smokePiTuiNativeLoad();
  smokeSqlite(manifest);
  process.stdout.write(`Native asset smoke passed: ${manifest.target}\n`);
}

export function runNativeAssetSmokeIfRequested(): boolean {
  if (process.env['KIMI_CODE_NATIVE_ASSET_SMOKE'] !== '1') return false;
  try {
    runSmoke();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Native asset smoke failed: ${message}\n`);
    process.exit(1);
  }
  return true;
}
