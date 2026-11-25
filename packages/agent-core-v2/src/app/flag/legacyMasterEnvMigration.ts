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
import lockfile from 'proper-lockfile';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { parseBooleanEnv } from '#/_base/utils/env';
import { resolveConfigPath } from '#/app/bootstrap/bootstrap';
import { isPlainObject } from '#/app/config/configPure';
import { planConfigWriteback } from '#/app/config/tomlWriteback';
import { TOWER_FLAG_ENV, TOWER_FLAG_ID } from '#/features/tower/tower';

import { EXPERIMENTAL_SECTION, ExperimentalConfigSchema } from './flag';
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
  readonly onBeforeWrite?: (attempt: number) => void;
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
const MAX_MIGRATION_WRITE_ATTEMPTS = 3;

function safeLstat(filePath: string): Stats | undefined {
  try {
    return lstatSync(filePath, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function assertWritableSingleLink(targetPath: string, targetStat: Stats): void {
  if (targetStat.nlink > 1) {
    const error = new Error(`Refusing to replace hard-linked file: ${targetPath}`) as NodeJS.ErrnoException;
    error.code = 'EPERM';
    throw error;
  }
  if (process.platform !== 'win32' && (targetStat.mode & 0o222) === 0) {
    const error = new Error(`Target file is read-only: ${targetPath}`) as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  }
  accessSync(targetPath, constants.W_OK);
}

function writeFileAtomically(filePath: string, content: string): void {
  const linkStat = safeLstat(filePath);
  const targetPath = linkStat !== undefined ? realpathSync(filePath) : filePath;
  const targetStat = linkStat !== undefined ? statSync(targetPath) : undefined;
  if (targetStat !== undefined) {
    assertWritableSingleLink(targetPath, targetStat);
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
  let stat: Stats | undefined;
  try {
    stat = lstatSync(markerPath, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
  if (stat === undefined) return {};
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
    if (!isPlainObject(raw)) return undefined;
    const legacyFlag = raw['legacyMasterEnvTowerMigrated'];
    if (legacyFlag !== undefined && typeof legacyFlag !== 'boolean') return undefined;
    const configs = raw['legacyMasterEnvTowerMigratedConfigs'];
    if (configs !== undefined) {
      if (!isPlainObject(configs)) return undefined;
      if (Object.values(configs).some((value) => typeof value !== 'boolean')) return undefined;
    }
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
    const latest = readMigrationsRecord(markerPath);
    if (latest === undefined) return false;
    const mergedBase: ExperimentalMigrationsRecord = {
      ...existing,
      ...latest,
      legacyMasterEnvTowerMigratedConfigs: {
        ...existing.legacyMasterEnvTowerMigratedConfigs,
        ...latest.legacyMasterEnvTowerMigratedConfigs,
      },
    };
    const next: ExperimentalMigrationsRecord = {
      ...mergedBase,
      ...(isDefaultConfig ? { legacyMasterEnvTowerMigrated: true } : {}),
      legacyMasterEnvTowerMigratedConfigs: {
        ...mergedBase.legacyMasterEnvTowerMigratedConfigs,
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

type ConfigInspectionResult =
  | {
      readonly kind: 'terminal';
      readonly outcome: 'fallback-env' | 'skipped-error';
    }
  | {
      readonly kind: 'already-configured';
    }
  | {
      readonly kind: 'needs-migration';
      readonly targetPath: string;
      readonly targetStat: Stats | undefined;
      readonly onDiskText: string | undefined;
      readonly parsedDoc: Record<string, unknown>;
      readonly rawExperimental: unknown;
      readonly validatedExperimental: Record<string, boolean> | undefined;
    };

function inspectConfigForTowerMigration(
  configPath: string,
  masterEnv: boolean | undefined,
): ConfigInspectionResult {
  const failOutcome = masterEnv === true ? 'fallback-env' : 'skipped-error';
  let configLinkStat: Stats | undefined;
  try {
    configLinkStat = lstatSync(configPath, { throwIfNoEntry: false });
  } catch {
    return { kind: 'terminal', outcome: failOutcome };
  }

  let targetPath = normalizeConfigKey(configPath);
  let targetStat: Stats | undefined;
  let onDiskText: string | undefined;
  let parsedDoc: Record<string, unknown> = {};

  if (configLinkStat !== undefined) {
    try {
      targetPath = realpathSync(configPath);
      targetStat = statSync(targetPath);
      onDiskText = readFileSync(targetPath, 'utf8');
      const parsed = parseToml(onDiskText);
      if (!isPlainObject(parsed)) {
        return { kind: 'terminal', outcome: failOutcome };
      }
      parsedDoc = parsed;
    } catch {
      return { kind: 'terminal', outcome: failOutcome };
    }
  }

  const rawExperimental = parsedDoc[EXPERIMENTAL_SECTION];
  let validatedExperimental: Record<string, boolean> | undefined;
  if (rawExperimental !== undefined) {
    if (!isPlainObject(rawExperimental)) {
      return { kind: 'terminal', outcome: failOutcome };
    }
    const parsedExperimental = ExperimentalConfigSchema.safeParse(rawExperimental);
    if (!parsedExperimental.success) {
      return { kind: 'terminal', outcome: failOutcome };
    }
    validatedExperimental = parsedExperimental.data;
  }

  if (validatedExperimental !== undefined && Object.hasOwn(validatedExperimental, TOWER_FLAG_ID)) {
    return { kind: 'already-configured' };
  }

  return {
    kind: 'needs-migration',
    targetPath,
    targetStat,
    onDiskText,
    parsedDoc,
    rawExperimental,
    validatedExperimental,
  };
}

function buildTowerMigratedConfigText(
  snapshot: Extract<ConfigInspectionResult, { readonly kind: 'needs-migration' }>,
): string {
  const nextExperimental: Record<string, unknown> = {
    ...snapshot.validatedExperimental,
    [TOWER_FLAG_ID]: true,
  };
  const nextDoc: Record<string, unknown> = {
    ...snapshot.parsedDoc,
    [EXPERIMENTAL_SECTION]: nextExperimental,
  };
  if (snapshot.onDiskText === undefined) {
    return `${stringifyToml(nextDoc).trimEnd()}\n`;
  }
  return (
    planConfigWriteback(
      snapshot.onDiskText,
      [
        {
          snakeKey: EXPERIMENTAL_SECTION,
          previousValue: snapshot.rawExperimental,
          nextValue: nextExperimental,
        },
      ],
      nextDoc,
    ) ?? `${stringifyToml(nextDoc).trimEnd()}\n`
  );
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
  if (record !== undefined && isConfigMigrated(record, configKey, isDefaultConfig)) {
    return 'already-migrated';
  }

  if (!isExistingInstallation(homeDir, configPath, defaultConfigPath)) {
    return record !== undefined &&
      stampMigrationMarker(markerPath, record, configKey, isDefaultConfig)
      ? 'stamped-fresh-install'
      : 'skipped-error';
  }

  const masterEnv = parseBooleanEnv(env[MASTER_ENV]);
  const towerEnvOverride = parseBooleanEnv(env[TOWER_FLAG_ENV]);
  if (towerEnvOverride === false) {
    return record !== undefined &&
      stampMigrationMarker(markerPath, record, configKey, isDefaultConfig)
      ? 'stamped-noop'
      : 'skipped-error';
  }

  const initial = inspectConfigForTowerMigration(configPath, masterEnv);
  if (initial.kind === 'terminal') {
    return initial.outcome;
  }
  if (initial.kind === 'already-configured') {
    return record !== undefined &&
      stampMigrationMarker(markerPath, record, configKey, isDefaultConfig)
      ? 'stamped-noop'
      : 'skipped-error';
  }

  if (masterEnv !== true) {
    return record === undefined ? 'skipped-error' : 'pending-master-env';
  }

  if (record === undefined) {
    return 'fallback-env';
  }

  try {
    if (initial.targetStat !== undefined) {
      assertWritableSingleLink(initial.targetPath, initial.targetStat);
    }
    mkdirSync(dirname(initial.targetPath), { recursive: true, mode: 0o700 });
  } catch {
    return 'fallback-env';
  }

  let releaseLock: (() => void) | undefined;
  try {
    releaseLock = lockfile.lockSync(initial.targetPath, {
      realpath: false,
      lockfilePath: `${initial.targetPath}.lock`,
    });
  } catch {
    return 'fallback-env';
  }

  try {
    let committed = false;
    for (let attempt = 0; attempt < MAX_MIGRATION_WRITE_ATTEMPTS; attempt += 1) {
      const current = inspectConfigForTowerMigration(configPath, true);
      if (current.kind === 'terminal') {
        return current.outcome;
      }
      if (current.kind === 'already-configured') {
        return stampMigrationMarker(markerPath, record, configKey, isDefaultConfig)
          ? 'stamped-noop'
          : 'skipped-error';
      }
      if (current.targetStat !== undefined) {
        assertWritableSingleLink(current.targetPath, current.targetStat);
      }
      const nextText = buildTowerMigratedConfigText(current);
      input.onBeforeWrite?.(attempt);

      if (current.onDiskText === undefined || current.targetStat === undefined) {
        if (safeLstat(configPath) !== undefined) {
          continue;
        }
        try {
          writeFileSync(current.targetPath, nextText, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
          });
          committed = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
            continue;
          }
          throw error;
        }
      }

      const fileMode = current.targetStat.mode & 0o777 || 0o600;
      const tempPath = `${current.targetPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tempPath, nextText, { encoding: 'utf8', mode: fileMode });
        const verifyLink = safeLstat(configPath);
        if (verifyLink === undefined) {
          unlinkSync(tempPath);
          continue;
        }
        const verifyTarget = realpathSync(configPath);
        const verifyStat = statSync(verifyTarget);
        assertWritableSingleLink(verifyTarget, verifyStat);
        const verifyText = readFileSync(verifyTarget, 'utf8');
        if (
          verifyTarget !== current.targetPath ||
          verifyStat.ino !== current.targetStat.ino ||
          verifyStat.mtimeMs !== current.targetStat.mtimeMs ||
          verifyStat.size !== current.targetStat.size ||
          verifyText !== current.onDiskText
        ) {
          unlinkSync(tempPath);
          continue;
        }
        renameSync(tempPath, current.targetPath);
        committed = true;
        break;
      } catch (error) {
        try {
          unlinkSync(tempPath);
        } catch {}
        throw error;
      }
    }
    if (!committed) {
      return 'fallback-env';
    }
  } catch {
    return 'fallback-env';
  } finally {
    try {
      releaseLock?.();
    } catch {}
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
