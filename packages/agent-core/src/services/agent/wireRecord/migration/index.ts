import { migrateV1_0ToV1_1 } from '../../../../agent/records/migration/v1.1';
import { migrateV1_1ToV1_2 } from '../../../../agent/records/migration/v1.2';
import { migrateV1_2ToV1_3 } from '../../../../agent/records/migration/v1.3';
import { migrateV1_3ToV1_4 } from '../../../../agent/records/migration/v1.4';
import { migrateV1_4ToV1_5 } from './v1.5';

export {
  migrateV1_0ToV1_1,
  migrateV1_1ToV1_2,
  migrateV1_2ToV1_3,
  migrateV1_3ToV1_4,
  migrateV1_4ToV1_5,
};

export const AGENT_WIRE_PROTOCOL_VERSION = '1.5';

export interface WireMigrationRecord {
  readonly type: string;
  [key: string]: unknown;
}

export interface WireMigration {
  readonly sourceVersion: string;
  readonly targetVersion: string;
  migrateRecord?(record: WireMigrationRecord): WireMigrationRecord | readonly WireMigrationRecord[];
  migrateRecords?(records: readonly WireMigrationRecord[]): readonly WireMigrationRecord[];
}

const MIGRATIONS: readonly WireMigration[] = [
  migrateV1_0ToV1_1,
  migrateV1_1ToV1_2,
  migrateV1_2ToV1_3,
  migrateV1_3ToV1_4,
  migrateV1_4ToV1_5,
];

export function isNewerWireVersion(readVersion: string): boolean {
  return compareWireVersions(readVersion, AGENT_WIRE_PROTOCOL_VERSION) > 0;
}

export function resolveWireMigrations(readVersion: string): readonly WireMigration[] {
  if (compareWireVersions(readVersion, AGENT_WIRE_PROTOCOL_VERSION) >= 0) {
    return [];
  }

  const migrations: WireMigration[] = [];
  let version = readVersion;
  while (compareWireVersions(version, AGENT_WIRE_PROTOCOL_VERSION) < 0) {
    const migration = findMigration(version);
    if (migration === undefined) {
      throw new Error(`Missing wire migration for version ${version}`);
    }
    migrations.push(migration);
    version = migration.targetVersion;
  }

  return migrations;
}

export function migrateWireRecord(
  record: WireMigrationRecord,
  migrations: readonly WireMigration[],
): WireMigrationRecord {
  const migrated = migrateWireRecordBatch(record, migrations);
  if (migrated.length !== 1) {
    throw new Error('Wire migration produced multiple records for a single-record migration');
  }
  return migrated[0]!;
}

export function migrateWireRecordBatch(
  record: WireMigrationRecord,
  migrations: readonly WireMigration[],
): WireMigrationRecord[] {
  return applyWireMigrations([record], migrations);
}

export function migrateWireRecords(
  records: readonly WireMigrationRecord[],
  readVersion: string | undefined,
): WireMigrationRecord[] {
  const migrations =
    readVersion === undefined ? MIGRATIONS : resolveWireMigrations(readVersion);
  return applyWireMigrations(records, migrations);
}

export function applyWireMigrations(
  records: readonly WireMigrationRecord[],
  migrations: readonly WireMigration[],
): WireMigrationRecord[] {
  let current = [...records];
  for (const migration of migrations) {
    current = applyWireMigration(current, migration);
  }
  return current;
}

function applyWireMigration(
  records: readonly WireMigrationRecord[],
  migration: WireMigration,
): WireMigrationRecord[] {
  if (migration.migrateRecords !== undefined) {
    return [...migration.migrateRecords(records)];
  }
  if (migration.migrateRecord === undefined) return [...records];
  const migrated: WireMigrationRecord[] = [];
  for (const record of records) {
    const result = migration.migrateRecord(record);
    if (isWireMigrationRecordArray(result)) {
      migrated.push(...result);
    } else {
      migrated.push(result);
    }
  }
  return migrated;
}

function isWireMigrationRecordArray(
  result: WireMigrationRecord | readonly WireMigrationRecord[],
): result is readonly WireMigrationRecord[] {
  return Array.isArray(result);
}

function findMigration(sourceVersion: string): WireMigration | undefined {
  for (const migration of MIGRATIONS) {
    if (migration.sourceVersion === sourceVersion) return migration;
  }
}

function compareWireVersions(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const maxLength = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLength; i++) {
    const diff = Number(partsA[i] ?? '0') - Number(partsB[i] ?? '0');
    if (diff !== 0) return diff;
  }

  return 0;
}
