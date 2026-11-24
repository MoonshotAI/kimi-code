import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'pathe';
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
  | 'skipped-error';

const EXISTING_INSTALL_MARKERS = ['sessions', 'credentials', 'user-history'] as const;

function writeFileAtomically(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function readMigrationsRecord(markerPath: string): ExperimentalMigrationsRecord | undefined {
  if (!existsSync(markerPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
    return isPlainObject(raw) ? (raw as ExperimentalMigrationsRecord) : undefined;
  } catch {
    return undefined;
  }
}

function stampMigrationMarker(markerPath: string, existing: ExperimentalMigrationsRecord): boolean {
  try {
    const next = {
      ...existing,
      legacyMasterEnvTowerMigrated: true,
    };
    writeFileAtomically(markerPath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function isExistingInstallation(homeDir: string, configPath: string): boolean {
  if (existsSync(configPath)) return true;
  return EXISTING_INSTALL_MARKERS.some((entry) => existsSync(join(homeDir, entry)));
}

export function migrateLegacyMasterEnvTower(
  input: MigrateLegacyMasterEnvTowerInput,
): MigrateLegacyMasterEnvTowerOutcome {
  const { homeDir } = input;
  const configPath = resolveConfigPath({ homeDir, configPath: input.configPath });
  const env = input.env ?? process.env;
  const markerPath = join(homeDir, EXPERIMENTAL_MIGRATIONS_FILENAME);

  const record = readMigrationsRecord(markerPath);
  if (record === undefined) return 'skipped-error';
  if (record.legacyMasterEnvTowerMigrated === true) return 'already-migrated';

  if (!isExistingInstallation(homeDir, configPath)) {
    return stampMigrationMarker(markerPath, record) ? 'stamped-fresh-install' : 'skipped-error';
  }

  const masterEnv = parseBooleanEnv(env[MASTER_ENV]);
  const towerEnvOverride = parseBooleanEnv(env[TOWER_FLAG_ENV]);
  if (masterEnv === false || towerEnvOverride === false) {
    return stampMigrationMarker(markerPath, record) ? 'stamped-noop' : 'skipped-error';
  }

  let onDiskText: string | undefined;
  let parsedDoc: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      onDiskText = readFileSync(configPath, 'utf8');
      const parsed = parseToml(onDiskText);
      if (!isPlainObject(parsed)) return 'skipped-error';
      parsedDoc = parsed;
    } catch {
      return 'skipped-error';
    }
  }

  const rawExperimental = parsedDoc[EXPERIMENTAL_SECTION];
  if (rawExperimental !== undefined && !isPlainObject(rawExperimental)) {
    return 'skipped-error';
  }
  if (isPlainObject(rawExperimental) && Object.hasOwn(rawExperimental, TOWER_FLAG_ID)) {
    return stampMigrationMarker(markerPath, record) ? 'stamped-noop' : 'skipped-error';
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
    return 'skipped-error';
  }

  return stampMigrationMarker(markerPath, record) ? 'migrated-tower' : 'skipped-error';
}
