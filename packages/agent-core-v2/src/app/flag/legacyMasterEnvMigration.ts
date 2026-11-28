import { existsSync, lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'pathe';

import { resolveConfigPath } from '#/app/bootstrap/bootstrap';
import { isPlainObject } from '#/app/config/configPure';
import { TOWER_FLAG_ID } from '#/features/tower/tower';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { ExperimentalConfig } from './flag';
import { EXPERIMENTAL_PROFILES, type ExperimentalProfile } from './flagRegistry';

export const EXPERIMENTAL_MIGRATIONS_FILENAME = 'experimental-migrations.json';

type MigratedProfileConfigMap = Partial<
  Record<ExperimentalProfile, Readonly<Record<string, boolean>>>
>;

export interface ExperimentalMigrationsRecord {
  readonly legacyMasterEnvTowerMigrated?: boolean;
  readonly legacyMasterEnvTowerMigratedConfigs?: Readonly<Record<string, boolean>>;
  readonly legacyMasterEnvTowerMigratedProfiles?: Readonly<MigratedProfileConfigMap>;
}

export type MigrationsMarkerReadResult =
  | { readonly status: 'missing'; readonly record: ExperimentalMigrationsRecord }
  | { readonly status: 'valid'; readonly record: ExperimentalMigrationsRecord }
  | { readonly status: 'corrupt' };

export type LegacyTowerMigrationPlan =
  | {
      readonly kind: 'noop';
      readonly initialMode: 'none';
    }
  | {
      readonly kind: 'fallback-only';
      readonly initialMode: 'fallback';
    }
  | {
      readonly kind: 'stamp';
      readonly initialMode: 'none';
      readonly profiles: readonly ExperimentalProfile[];
      readonly configKeys: readonly string[];
      readonly includesDefaultConfig: boolean;
      readonly initialRecord: ExperimentalMigrationsRecord;
    }
  | {
      readonly kind: 'migrate-config';
      readonly initialMode: 'pending-persist';
      readonly profile: ExperimentalProfile;
      readonly configKey: string;
      readonly isDefaultConfig: boolean;
      readonly initialRecord: ExperimentalMigrationsRecord;
    };

export interface PlanLegacyTowerMigrationInput {
  readonly homeDir: string;
  readonly configPath: string;
  readonly profile: ExperimentalProfile;
  readonly masterEnv: boolean | undefined;
  readonly towerEnvOverride: boolean | undefined;
  readonly validatedExperimental: ExperimentalConfig | undefined;
  readonly rawExperimental: unknown;
}

const EXISTING_INSTALL_MARKERS = ['sessions', 'credentials', 'user-history'] as const;
const EXPERIMENTAL_PROFILE_SET: ReadonlySet<string> = new Set(EXPERIMENTAL_PROFILES);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function safeLstat(filePath: string): Stats | undefined {
  try {
    return lstatSync(filePath, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

export function normalizeMigrationConfigKey(configPath: string): string {
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

function parseMigrationsRecordText(text: string): ExperimentalMigrationsRecord | undefined {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isPlainObject(raw)) return undefined;
    const legacyFlag = raw['legacyMasterEnvTowerMigrated'];
    if (legacyFlag !== undefined && typeof legacyFlag !== 'boolean') return undefined;
    const configs = raw['legacyMasterEnvTowerMigratedConfigs'];
    if (configs !== undefined) {
      if (!isPlainObject(configs)) return undefined;
      if (Object.values(configs).some((value) => typeof value !== 'boolean')) return undefined;
    }
    const profiles = raw['legacyMasterEnvTowerMigratedProfiles'];
    if (profiles !== undefined) {
      if (!isPlainObject(profiles)) return undefined;
      for (const [profileKey, bucket] of Object.entries(profiles)) {
        if (!EXPERIMENTAL_PROFILE_SET.has(profileKey) || !isPlainObject(bucket)) {
          return undefined;
        }
        if (Object.values(bucket).some((value) => typeof value !== 'boolean')) {
          return undefined;
        }
      }
    }
    return raw as ExperimentalMigrationsRecord;
  } catch {
    return undefined;
  }
}

function readMigrationsRecordSync(markerPath: string): MigrationsMarkerReadResult {
  let stat: Stats | undefined;
  try {
    stat = lstatSync(markerPath, { throwIfNoEntry: false });
  } catch {
    return { status: 'corrupt' };
  }
  if (stat === undefined) return { status: 'missing', record: {} };
  if (!stat.isFile() || stat.nlink > 1) return { status: 'corrupt' };
  try {
    const record = parseMigrationsRecordText(readFileSync(markerPath, 'utf8'));
    return record === undefined ? { status: 'corrupt' } : { status: 'valid', record };
  } catch {
    return { status: 'corrupt' };
  }
}

export async function readMigrationsRecordFromStorage(
  storage: IFileSystemStorageService,
): Promise<MigrationsMarkerReadResult> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await storage.read('', EXPERIMENTAL_MIGRATIONS_FILENAME);
  } catch {
    return { status: 'corrupt' };
  }
  if (bytes === undefined) return { status: 'missing', record: {} };
  const record = parseMigrationsRecordText(textDecoder.decode(bytes));
  return record === undefined ? { status: 'corrupt' } : { status: 'valid', record };
}

export function isConfigMigrated(
  record: ExperimentalMigrationsRecord,
  profile: ExperimentalProfile,
  configKey: string,
  isDefaultConfig: boolean,
): boolean {
  if (record.legacyMasterEnvTowerMigratedProfiles?.[profile]?.[configKey] === true) {
    return true;
  }
  if (profile === 'cli') {
    if (record.legacyMasterEnvTowerMigratedConfigs?.[configKey] === true) return true;
    if (isDefaultConfig && record.legacyMasterEnvTowerMigrated === true) return true;
  }
  return false;
}

function mergeProfileRecords(
  first: Readonly<MigratedProfileConfigMap> | undefined,
  second: Readonly<MigratedProfileConfigMap> | undefined,
): MigratedProfileConfigMap {
  const merged: MigratedProfileConfigMap = {};
  for (const profile of EXPERIMENTAL_PROFILES) {
    const left = first?.[profile];
    const right = second?.[profile];
    if (left !== undefined || right !== undefined) {
      merged[profile] = { ...left, ...right };
    }
  }
  return merged;
}

function buildStampedMigrationsRecord(
  existing: ExperimentalMigrationsRecord,
  latest: ExperimentalMigrationsRecord,
  profiles: readonly ExperimentalProfile[],
  configKeys: readonly string[],
  includesDefaultConfig: boolean,
): ExperimentalMigrationsRecord {
  const mergedProfiles = mergeProfileRecords(
    existing.legacyMasterEnvTowerMigratedProfiles,
    latest.legacyMasterEnvTowerMigratedProfiles,
  );
  const mergedBase: ExperimentalMigrationsRecord = {
    ...existing,
    ...latest,
    legacyMasterEnvTowerMigratedConfigs: {
      ...existing.legacyMasterEnvTowerMigratedConfigs,
      ...latest.legacyMasterEnvTowerMigratedConfigs,
    },
    legacyMasterEnvTowerMigratedProfiles: mergedProfiles,
  };
  const stampsCli = profiles.includes('cli');
  const nextProfiles: MigratedProfileConfigMap = { ...mergedProfiles };
  for (const targetProfile of profiles) {
    const bucket: Record<string, boolean> = { ...nextProfiles[targetProfile] };
    for (const key of configKeys) {
      bucket[key] = true;
    }
    nextProfiles[targetProfile] = bucket;
  }
  const nextConfigs: Record<string, boolean> = {
    ...mergedBase.legacyMasterEnvTowerMigratedConfigs,
  };
  if (stampsCli) {
    for (const key of configKeys) {
      nextConfigs[key] = true;
    }
  }
  return {
    ...mergedBase,
    ...(stampsCli && includesDefaultConfig ? { legacyMasterEnvTowerMigrated: true } : {}),
    ...(stampsCli ? { legacyMasterEnvTowerMigratedConfigs: nextConfigs } : {}),
    legacyMasterEnvTowerMigratedProfiles: nextProfiles,
  };
}

function canPersistRegularFileOnDisk(filePath: string): boolean {
  const linkStat = safeLstat(filePath);
  if (linkStat === undefined) return true;
  if (!linkStat.isFile() || linkStat.nlink > 1) return false;
  if (process.platform !== 'win32' && (linkStat.mode & 0o222) === 0) return false;
  return true;
}

export function canPersistConfigViaConfigService(
  configPath: string,
  homeDir: string,
  storage: IFileSystemStorageService,
): boolean {
  if (dirname(resolve(configPath)) !== resolve(homeDir)) return false;
  if (!(storage instanceof FileStorageService)) return true;
  return canPersistRegularFileOnDisk(configPath);
}

export async function writeStampedMigrationsRecord(
  storage: IFileSystemStorageService,
  homeDir: string,
  initialRecord: ExperimentalMigrationsRecord,
  profiles: readonly ExperimentalProfile[],
  configKeys: readonly string[],
  includesDefaultConfig: boolean,
): Promise<boolean> {
  if (
    storage instanceof FileStorageService &&
    !canPersistRegularFileOnDisk(join(homeDir, EXPERIMENTAL_MIGRATIONS_FILENAME))
  ) {
    return false;
  }
  const latest = await readMigrationsRecordFromStorage(storage);
  if (latest.status === 'corrupt') return false;
  const next = buildStampedMigrationsRecord(
    initialRecord,
    latest.record,
    profiles,
    configKeys,
    includesDefaultConfig,
  );
  await storage.write(
    '',
    EXPERIMENTAL_MIGRATIONS_FILENAME,
    textEncoder.encode(`${JSON.stringify(next, null, 2)}\n`),
    { atomic: true },
  );
  return true;
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

export function readRawProfileTowerValue(
  rawExperimental: unknown,
  profile: ExperimentalProfile,
): unknown {
  if (!isPlainObject(rawExperimental)) return undefined;
  const bucket = rawExperimental[profile];
  if (!isPlainObject(bucket)) return undefined;
  return bucket[TOWER_FLAG_ID];
}

export function planLegacyMasterEnvTowerMigration(
  input: PlanLegacyTowerMigrationInput,
  storage: IFileSystemStorageService,
): LegacyTowerMigrationPlan {
  const { homeDir, configPath, profile, masterEnv, towerEnvOverride } = input;
  const defaultConfigPath = resolveConfigPath({ homeDir });
  const configKey = normalizeMigrationConfigKey(configPath);
  const defaultConfigKey = normalizeMigrationConfigKey(defaultConfigPath);
  const isDefaultConfig = configKey === defaultConfigKey;

  const marker =
    storage instanceof FileStorageService
      ? readMigrationsRecordSync(join(homeDir, EXPERIMENTAL_MIGRATIONS_FILENAME))
      : ({ status: 'missing', record: {} } as const);

  if (
    marker.status !== 'corrupt' &&
    isConfigMigrated(marker.record, profile, configKey, isDefaultConfig)
  ) {
    return { kind: 'noop', initialMode: 'none' };
  }

  const hasInMemoryConfig = input.rawExperimental !== undefined;
  const existingInstall =
    hasInMemoryConfig || isExistingInstallation(homeDir, configPath, defaultConfigPath);

  if (!existingInstall) {
    if (marker.status === 'corrupt') {
      return { kind: 'noop', initialMode: 'none' };
    }
    const freshConfigKeys = isDefaultConfig ? [configKey] : [configKey, defaultConfigKey];
    return {
      kind: 'stamp',
      initialMode: 'none',
      profiles: EXPERIMENTAL_PROFILES,
      configKeys: freshConfigKeys,
      includesDefaultConfig: true,
      initialRecord: marker.record,
    };
  }

  const validatedTower = input.validatedExperimental?.[profile]?.[TOWER_FLAG_ID];
  if (towerEnvOverride !== undefined || validatedTower !== undefined) {
    if (marker.status === 'corrupt') {
      return { kind: 'noop', initialMode: 'none' };
    }
    return {
      kind: 'stamp',
      initialMode: 'none',
      profiles: [profile],
      configKeys: [configKey],
      includesDefaultConfig: isDefaultConfig,
      initialRecord: marker.record,
    };
  }

  if (readRawProfileTowerValue(input.rawExperimental, profile) === false) {
    return { kind: 'noop', initialMode: 'none' };
  }

  if (masterEnv !== true) {
    return { kind: 'noop', initialMode: 'none' };
  }

  if (
    marker.status === 'corrupt' ||
    !canPersistConfigViaConfigService(configPath, homeDir, storage)
  ) {
    return { kind: 'fallback-only', initialMode: 'fallback' };
  }

  return {
    kind: 'migrate-config',
    initialMode: 'pending-persist',
    profile,
    configKey,
    isDefaultConfig,
    initialRecord: marker.record,
  };
}
