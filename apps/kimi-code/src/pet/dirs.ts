/**
 * Desktop-pet data paths.
 *
 * These intentionally do NOT reuse `#/utils/paths`: that module pulls in
 * `#/constant/app`, which value-imports the whole SDK — fine for the main
 * bundle, but the pet overlay is bundled separately and runs under Electron,
 * where dragging in the SDK would bloat it by ~10 MB. The resolution rule
 * (`KIMI_CODE_HOME` env > `~/.kimi-code`) mirrors `getDataDir()` and must be
 * kept in sync with it.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const KIMI_CODE_HOME_ENV = 'KIMI_CODE_HOME';
const KIMI_CODE_DATA_DIR_NAME = '.kimi-code';

/** Root data directory: `KIMI_CODE_HOME` env var > `~/.kimi-code`. */
export function getPetDataDir(): string {
  const envDir = process.env[KIMI_CODE_HOME_ENV];
  if (envDir !== undefined && envDir !== '') {
    return envDir;
  }
  return join(homedir(), KIMI_CODE_DATA_DIR_NAME);
}

/** Desktop-pet root directory: `<dataDir>/pet/`. */
export function getPetDir(): string {
  return join(getPetDataDir(), 'pet');
}

/** One state file per reported session: `<dataDir>/pet/sessions/`. */
export function getPetSessionsDir(): string {
  return join(getPetDir(), 'sessions');
}

/** Custom pet skin root: `<dataDir>/pet/pets/`. */
export function getPetSkinsDir(): string {
  return join(getPetDir(), 'pets');
}

/** Overlay heartbeat file: `<dataDir>/pet/overlay.json`. */
export function getPetOverlayHeartbeatFile(): string {
  return join(getPetDir(), 'overlay.json');
}

/** Overlay pidfile: `<dataDir>/pet/overlay.pid`. */
export function getPetOverlayPidFile(): string {
  return join(getPetDir(), 'overlay.pid');
}

/** Persisted pet window position: `<dataDir>/pet/overlay-position.json`. */
export function getPetOverlayPositionFile(): string {
  return join(getPetDir(), 'overlay-position.json');
}

/** Pet display settings (size scale): `<dataDir>/pet/settings.json`. */
export function getPetSettingsFile(): string {
  return join(getPetDir(), 'settings.json');
}
