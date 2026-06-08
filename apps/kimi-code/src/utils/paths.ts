/**
 * CLI-owned data path helpers.
 *
 * These paths are for local app data such as logs and input history. Config
 * files are owned by Core/SDK and intentionally do not live behind this module.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  KIMI_CODE_BIN_DIR_NAME,
  KIMI_CODE_DATA_DIR_NAME,
  KIMI_CODE_HOME_ENV,
  KIMI_CODE_INPUT_HISTORY_DIR_NAME,
  KIMI_CODE_LOG_DIR_NAME,
  KIMI_CODE_UPDATE_INSTALL_LOCK_FILE_NAME,
  KIMI_CODE_UPDATE_INSTALL_STATE_FILE_NAME,
  KIMI_CODE_UPDATE_DIR_NAME,
  KIMI_CODE_UPDATE_STATE_FILE_NAME,
} from '#/constant/app';

/**
 * Return the root data directory for Kimi Code.
 *
 * Priority: `KIMI_CODE_HOME` env var > `~/.kimi-code`.
 */
export function getDataDir(): string {
  const envDir = process.env[KIMI_CODE_HOME_ENV];
  if (envDir) {
    return envDir;
  }
  return join(homedir(), KIMI_CODE_DATA_DIR_NAME);
}

/**
 * Return the diagnostic log directory: `<dataDir>/logs/`.
 */
export function getLogDir(): string {
  return join(getDataDir(), KIMI_CODE_LOG_DIR_NAME);
}

/**
 * Return the managed tools directory: `<dataDir>/bin/`.
 */
export function getBinDir(): string {
  return join(getDataDir(), KIMI_CODE_BIN_DIR_NAME);
}

/**
 * Return the update cache file: `<dataDir>/updates/latest.json`.
 */
export function getUpdateStateFile(): string {
  return join(getDataDir(), KIMI_CODE_UPDATE_DIR_NAME, KIMI_CODE_UPDATE_STATE_FILE_NAME);
}

/**
 * Return the update install state file: `<dataDir>/updates/install.json`.
 */
export function getUpdateInstallStateFile(): string {
  return join(getDataDir(), KIMI_CODE_UPDATE_DIR_NAME, KIMI_CODE_UPDATE_INSTALL_STATE_FILE_NAME);
}

/**
 * Return the update install lock file: `<dataDir>/updates/install.lock`.
 */
export function getUpdateInstallLockFile(): string {
  return join(getDataDir(), KIMI_CODE_UPDATE_DIR_NAME, KIMI_CODE_UPDATE_INSTALL_LOCK_FILE_NAME);
}

/**
 * Return the user input history file for a given working directory.
 * Layout: `<share_dir>/user-history/<md5(cwd)>.jsonl`.
 */
export function getInputHistoryFile(workDir: string): string {
  const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
  return join(getDataDir(), KIMI_CODE_INPUT_HISTORY_DIR_NAME, `${hash}.jsonl`);
}
