export const AGENT_WIRE_PROTOCOL_VERSION = '1.0';

export interface WireMigrationRecord {
  readonly type: string;
  [key: string]: unknown;
}

export interface WireMigration {
  readonly sourceVersion: string;
  readonly targetVersion: string;
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord;
}

const MIGRATIONS: readonly WireMigration[] = [];

export function resolveWireMigrations(readVersion: string): readonly WireMigration[] {
  if (compareWireVersions(readVersion, AGENT_WIRE_PROTOCOL_VERSION) === 0) {
    return [];
  }
  if (compareWireVersions(readVersion, AGENT_WIRE_PROTOCOL_VERSION) > 0) {
    throw new Error(
      `Unsupported wire protocol version: ${readVersion} (current: ${AGENT_WIRE_PROTOCOL_VERSION})`,
    );
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
