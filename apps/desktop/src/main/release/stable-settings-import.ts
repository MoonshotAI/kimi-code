
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import { isCanaryVersion } from './release-channel';

export const STABLE_USERDATA_NAME = 'kimi-code-app';

const LOCAL_STORAGE_LEVELDB = join('Local Storage', 'leveldb');
const MARKER_NAME = '.stable-ui-settings-import.json';
const BACKUP_DIR_NAME = 'leveldb.bak';

export type StableImportPrecheck = 'ok' | 'unavailable' | 'no-stable-data' | 'stable-running';

export interface StableImportMarker {
  sourceDir: string;
  createdAt: string;
}

export interface StableImportOutcome {
  ok: boolean;
  backedUp: boolean;
  error?: string;
}

export function stableUserDataDir(appDataDir: string): string {
  return join(appDataDir, STABLE_USERDATA_NAME);
}

export function canImportStableSettings(version: string, platform: NodeJS.Platform): boolean {
  return isCanaryVersion(version) && platform === 'darwin';
}

export function isStableAppRunning(
  run: (file: string, args: string[]) => string = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
): boolean {
  try {
    run('pgrep', ['-f', 'Kimi Code\\.app/Contents/MacOS/Kimi Code( |$)']);
    return true;
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    return status === 1 ? false : true;
  }
}

export function stableSettingsPrecheck(
  version: string,
  platform: NodeJS.Platform,
  appDataDir: string,
  run?: (file: string, args: string[]) => string,
): StableImportPrecheck {
  if (!canImportStableSettings(version, platform)) return 'unavailable';
  if (!existsSync(join(stableUserDataDir(appDataDir), LOCAL_STORAGE_LEVELDB))) return 'no-stable-data';
  if (isStableAppRunning(run)) return 'stable-running';
  return 'ok';
}

export function writeImportMarker(userDataDir: string, sourceDir: string): void {
  const marker: StableImportMarker = { sourceDir, createdAt: new Date().toISOString() };
  writeFileSync(join(userDataDir, MARKER_NAME), JSON.stringify(marker), 'utf8');
}

export function consumeImportMarker(userDataDir: string): StableImportMarker | null {
  const markerPath = join(userDataDir, MARKER_NAME);
  if (!existsSync(markerPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(markerPath, 'utf8');
  } catch {
    raw = '';
  }
  rmSync(markerPath, { force: true });
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { sourceDir, createdAt } = parsed as { sourceDir?: unknown; createdAt?: unknown };
    if (typeof sourceDir !== 'string' || sourceDir === '') return null;
    return { sourceDir, createdAt: typeof createdAt === 'string' ? createdAt : '' };
  } catch {
    return null;
  }
}

export function performStableSettingsImport(userDataDir: string, sourceDir: string): StableImportOutcome {
  const source = join(sourceDir, LOCAL_STORAGE_LEVELDB);
  const dest = join(userDataDir, LOCAL_STORAGE_LEVELDB);
  if (!existsSync(source)) {
    return { ok: false, backedUp: false, error: `stable localStorage not found: ${source}` };
  }
  let backedUp = false;
  if (existsSync(dest)) {
    const backup = join(dirname(dest), BACKUP_DIR_NAME);
    rmSync(backup, { recursive: true, force: true });
    renameSync(dest, backup);
    backedUp = true;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true });
  return { ok: true, backedUp };
}

export function consumePendingStableImport(
  userDataDir: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  run?: (file: string, args: string[]) => string,
): void {
  const marker = consumeImportMarker(userDataDir);
  if (marker === null) return;
  if (isStableAppRunning(run)) {
    logger.warn('[kimi-desktop] stable UI-settings import skipped: the stable app is running (marker consumed)');
    return;
  }
  const outcome = performStableSettingsImport(userDataDir, marker.sourceDir);
  if (outcome.ok) {
    logger.info(`[kimi-desktop] imported UI settings from the stable app (backup=${outcome.backedUp ? 'leveldb.bak' : 'none'})`);
  } else {
    logger.warn(`[kimi-desktop] stable UI-settings import failed: ${outcome.error ?? 'unknown error'}`);
  }
}
