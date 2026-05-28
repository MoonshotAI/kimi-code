import { migrateV1_0ToV1_1 } from './v1.1';
import { migrateV1_1ToV1_2 } from './v1.2';
import { migrateV1_2ToV1_3 } from './v1.3';

// Wire protocol versions currently support only the `number.number` format.
export const AGENT_WIRE_PROTOCOL_VERSION = '1.3';

export interface WireMigrationRecord {
  readonly type: string;
  [key: string]: unknown;
}

export interface WireMigration {
  readonly sourceVersion: string;
  readonly targetVersion: string;
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord;
}

const MIGRATIONS: readonly WireMigration[] = [
  migrateV1_0ToV1_1,
  migrateV1_1ToV1_2,
  migrateV1_2ToV1_3,
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
  return migrations.reduce(
    (current, migration) => migration.migrateRecord(current),
    record,
  );
}

export function migrateWireRecords(
  records: readonly WireMigrationRecord[],
  readVersion: string | undefined,
): WireMigrationRecord[] {
  const migrations =
    readVersion === undefined ? MIGRATIONS : resolveWireMigrations(readVersion);
  return records.map((record) => migrateWireRecord(record, migrations));
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
