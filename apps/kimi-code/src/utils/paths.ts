import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  KIMI_CODE_BANNER_DIR_NAME,
  KIMI_CODE_BANNER_STATE_FILE_NAME,
  KIMI_CODE_BIN_DIR_NAME,
  KIMI_CODE_CACHE_DIR_NAME,
  KIMI_CODE_DATA_DIR_NAME,
  KIMI_CODE_HOME_ENV,
  KIMI_CODE_INPUT_HISTORY_DIR_NAME,
  KIMI_CODE_LOG_DIR_NAME,
  KIMI_CODE_MODEL_MIGRATION_STATE_FILE_NAME,
  KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME,
  KIMI_CODE_NATIVE_STAGING_DIR_NAME,
  KIMI_CODE_PLUGIN_UPDATE_NOTICE_STATE_FILE_NAME,
  KIMI_CODE_RECOMMENDED_EFFORT_STATE_FILE_NAME,
  KIMI_CODE_UPDATE_INSTALL_LOCK_FILE_NAME,
  KIMI_CODE_UPDATE_INSTALL_STATE_FILE_NAME,
  KIMI_CODE_UPDATE_DIR_NAME,
  KIMI_CODE_UPDATE_ROLLOUT_LOG_FILE_NAME,
  KIMI_CODE_UPDATE_STATE_FILE_NAME,
} from '#/constant/app';

export function getDataDir(): string {
  const envDir = process.env[KIMI_CODE_HOME_ENV];
  if (envDir) {
    return envDir;
  }
  return join(homedir(), KIMI_CODE_DATA_DIR_NAME);
}

export function getLogDir(): string {
  return join(getDataDir(), KIMI_CODE_LOG_DIR_NAME);
}

export function getCacheDir(): string {
  return join(getDataDir(), KIMI_CODE_CACHE_DIR_NAME);
}

export function getBinDir(): string {
  return join(getDataDir(), KIMI_CODE_BIN_DIR_NAME);
}

export function getUpdateStateFile(): string {
  return join(getDataDir(), KIMI_CODE_UPDATE_DIR_NAME, KIMI_CODE_UPDATE_STATE_FILE_NAME);
}

export function getUpdateInstallStateFile(): string {
  return join(getDataDir(), KIMI_CODE_UPDATE_DIR_NAME, KIMI_CODE_UPDATE_INSTALL_STATE_FILE_NAME);
}

export function getUpdateInstallLockFile(): string {
  return join(getDataDir(), KIMI_CODE_UPDATE_DIR_NAME, KIMI_CODE_UPDATE_INSTALL_LOCK_FILE_NAME);
}

export function getUpdateRolloutLogFile(): string {
  return join(getDataDir(), KIMI_CODE_UPDATE_DIR_NAME, KIMI_CODE_UPDATE_ROLLOUT_LOG_FILE_NAME);
}

export function getPluginUpdateNoticeStateFile(): string {
  return join(
    getDataDir(),
    KIMI_CODE_UPDATE_DIR_NAME,
    KIMI_CODE_PLUGIN_UPDATE_NOTICE_STATE_FILE_NAME,
  );
}

export function getNativeStagingDir(exePath: string): string {
  return join(dirname(exePath), KIMI_CODE_NATIVE_STAGING_DIR_NAME);
}

export function getNativeStagedStateFile(exePath: string): string {
  return join(getNativeStagingDir(exePath), KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME);
}

export function getBannerStateFile(): string {
  return join(getCacheDir(), KIMI_CODE_BANNER_DIR_NAME, KIMI_CODE_BANNER_STATE_FILE_NAME);
}


export function getRecommendedEffortStateFile(): string {
  return join(getDataDir(), KIMI_CODE_RECOMMENDED_EFFORT_STATE_FILE_NAME);
}

export function getModelMigrationStateFile(): string {
  return join(getDataDir(), KIMI_CODE_MODEL_MIGRATION_STATE_FILE_NAME);
}

export function getInputHistoryFile(workDir: string): string {
  const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
  return join(getDataDir(), KIMI_CODE_INPUT_HISTORY_DIR_NAME, `${hash}.jsonl`);
}
