import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'pathe';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { parseBooleanEnv } from '#/_base/utils/env';
import { resolveConfigPath } from '#/app/bootstrap/bootstrap';
import { isPlainObject } from '#/app/config/configPure';
import { planConfigWriteback } from '#/app/config/tomlWriteback';
import { TOWER_FLAG_ENV, TOWER_FLAG_ID } from '#/features/tower/tower';

import { EXPERIMENTAL_SECTION } from './flag';
import { MASTER_ENV } from './flagService';

export const EXPERIMENTAL_MIGRATIONS_FILENAME = 'experimental-migrations.json';

interface ExperimentalMigrationsRecord {
  readonly legacyMasterEnvTowerMigrated?: boolean;
  readonly legacyMasterEnvTowerMigratedConfigs?: Readonly<Record<string, boolean>>;
}

export interface MigrateLegacyMasterEnvTowerInput {
  readonly homeDir: string;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type MigrateLegacyMasterEnvTowerOutcome =
  | 'already-migrated'
  | 'stamped-fresh-install'
  | 'stamped-noop'
  | 'pending-master-env'
  | 'migrated-tower'
  | 'fallback-env'
  | 'skipped-error';

const EXISTING_INSTALL_MARKERS = ['sessions', 'credentials', 'user-history'] as const;

function safeLstat(filePath: string): Stats | undefined {
  try {
    return lstatSync(filePath, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function writeFileAtomically(filePath: string, content: string): void {
  const linkStat = safeLstat(filePath);
  const targetPath = linkStat !== undefined ? realpathSync(filePath) : filePath;
  const targetStat = linkStat !== undefined ? statSync(targetPath) : undefined;
  if (targetStat !== undefined) {
    if (process.platform !== 'win32' && (targetStat.mode & 0o222) === 0) {
      const error = new Error(`Target file is read-only: ${targetPath}`) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    accessSync(targetPath, constants.W_OK);
  }
  const fileMode = targetStat !== undefined ? targetStat.mode & 0o777 || 0o600 : 0o600;
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: fileMode });
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function normalizeConfigKey(configPath: string): string {
  const resolved = resolve(configPath);
  try {
    return realpathSync(resolved);
  } catch {
    try {
      return join(realpathSync(dirname(resolved)), basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function readMigrationsRecord(markerPath: string): ExperimentalMigrationsRecord | undefined {
  if (safeLstat(markerPath) === undefined) return {};
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
    if (!isPlainObject(raw)) return undefined;
    const configs = raw['legacyMasterEnvTowerMigratedConfigs'];
    if (configs !== undefined && !isPlainObject(configs)) return undefined;
    return raw as ExperimentalMigrationsRecord;
  } catch {
    return undefined;
  }
}

function isConfigMigrated(
  record: ExperimentalMigrationsRecord,
  configKey: string,
  isDefaultConfig: boolean,
): boolean {
  if (record.legacyMasterEnvTowerMigratedConfigs?.[configKey] === true) return true;
  return isDefaultConfig && record.legacyMasterEnvTowerMigrated === true;
}

function stampMigrationMarker(
  markerPath: string,
  existing: ExperimentalMigrationsRecord,
  configKey: string,
  isDefaultConfig: boolean,
): boolean {
  try {
    const next: ExperimentalMigrationsRecord = {
      ...existing,
      ...(isDefaultConfig ? { legacyMasterEnvTowerMigrated: true } : {}),
      legacyMasterEnvTowerMigratedConfigs: {
        ...existing.legacyMasterEnvTowerMigratedConfigs,
        [configKey]: true,
      },
    };
    writeFileAtomically(markerPath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function isExistingInstallation(
  homeDir: string,
  configPath: string,
  defaultConfigPath: string,
): boolean {
  if (safeLstat(configPath) !== undefined) return true;
  if (safeLstat(defaultConfigPath) !== undefined) return true;
  return EXISTING_INSTALL_MARKERS.some((entry) => existsSync(join(homeDir, entry)));
}

export function migrateLegacyMasterEnvTower(
  input: MigrateLegacyMasterEnvTowerInput,
): MigrateLegacyMasterEnvTowerOutcome {
  const { homeDir } = input;
  const defaultConfigPath = resolveConfigPath({ homeDir });
  const configPath = resolveConfigPath({ homeDir, configPath: input.configPath });
  const defaultConfigKey = normalizeConfigKey(defaultConfigPath);
  const configKey = normalizeConfigKey(configPath);
  const isDefaultConfig = configKey === defaultConfigKey;
  const env = input.env ?? process.env;
  const markerPath = join(homeDir, EXPERIMENTAL_MIGRATIONS_FILENAME);

  const record = readMigrationsRecord(markerPath);
  if (record === undefined) return 'skipped-error';
  if (isConfigMigrated(record, configKey, isDefaultConfig)) return 'already-migrated';

  if (!isExistingInstallation(homeDir, configPath, defaultConfigPath)) {
    return stampMigrationMarker(markerPath, record, configKey, isDefaultConfig)
      ? 'stamped-fresh-install'
      : 'skipped-error';
  }

  const masterEnv = parseBooleanEnv(env[MASTER_ENV]);
  const towerEnvOverride = parseBooleanEnv(env[TOWER_FLAG_ENV]);
  if (towerEnvOverride === false) {
    return stampMigrationMarker(markerPath, record, configKey, isDefaultConfig)
      ? 'stamped-noop'
      : 'skipped-error';
  }

  let onDiskText: string | undefined;
  let parsedDoc: Record<string, unknown> = {};
  const configLinkStat = safeLstat(configPath);
  if (configLinkStat !== undefined) {
    try {
      onDiskText = readFileSync(configPath, 'utf8');
      const parsed = parseToml(onDiskText);
      if (!isPlainObject(parsed)) {
        return masterEnv === true ? 'fallback-env' : 'skipped-error';
      }
      parsedDoc = parsed;
    } catch {
      return masterEnv === true ? 'fallback-env' : 'skipped-error';
    }
  }

  const rawExperimental = parsedDoc[EXPERIMENTAL_SECTION];
  if (rawExperimental !== undefined && !isPlainObject(rawExperimental)) {
    return masterEnv === true ? 'fallback-env' : 'skipped-error';
  }
  if (isPlainObject(rawExperimental) && Object.hasOwn(rawExperimental, TOWER_FLAG_ID)) {
    return stampMigrationMarker(markerPath, record, configKey, isDefaultConfig)
      ? 'stamped-noop'
      : 'skipped-error';
  }

  if (masterEnv !== true) {
    return 'pending-master-env';
  }

  const nextExperimental: Record<string, unknown> = {
    ...(isPlainObject(rawExperimental) ? rawExperimental : {}),
    [TOWER_FLAG_ID]: true,
  };
  const nextDoc: Record<string, unknown> = {
    ...parsedDoc,
    [EXPERIMENTAL_SECTION]: nextExperimental,
  };

  try {
    const nextText =
      onDiskText === undefined
        ? `${stringifyToml(nextDoc).trimEnd()}\n`
        : (planConfigWriteback(
            onDiskText,
            [
              {
                snakeKey: EXPERIMENTAL_SECTION,
                previousValue: rawExperimental,
                nextValue: nextExperimental,
              },
            ],
            nextDoc,
          ) ?? `${stringifyToml(nextDoc).trimEnd()}\n`);
    writeFileAtomically(configPath, nextText);
  } catch {
    return 'fallback-env';
  }

  return stampMigrationMarker(markerPath, record, configKey, isDefaultConfig)
    ? 'migrated-tower'
    : 'skipped-error';
}

export function resolveBootstrapEnvWithLegacyTowerMigration(
  input: MigrateLegacyMasterEnvTowerInput,
): NodeJS.ProcessEnv | undefined {
  const outcome = migrateLegacyMasterEnvTower(input);
  if (outcome !== 'fallback-env') {
    return input.env;
  }
  const baseEnv = input.env ?? process.env;
  const existingTowerEnv = baseEnv[TOWER_FLAG_ENV];
  return {
    ...baseEnv,
    [TOWER_FLAG_ENV]: parseBooleanEnv(existingTowerEnv) === true ? existingTowerEnv : '1',
  };
}
