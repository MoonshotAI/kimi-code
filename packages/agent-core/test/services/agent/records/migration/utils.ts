import {
  applyWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from '../../../../../src/services/agent';
import { eventSnapshot } from '../../harness/snapshots';

export function runMigration(
  migration: WireMigration,
  records: readonly WireMigrationRecord[],
) {
  return wireSnapshot(records.map((record) => migrateRecord(migration, record)));
}

export function runMigrationRecords(
  migration: WireMigration,
  records: readonly WireMigrationRecord[],
) {
  return wireSnapshot(
    applyWireMigrations(records, [migration]).map((record) => updateMetadata(migration, record)),
  );
}

function migrateRecord(
  migration: WireMigration,
  record: WireMigrationRecord,
): WireMigrationRecord {
  if (migration.migrateRecord === undefined) {
    throw new Error(`Migration ${migration.sourceVersion} requires batch migration`);
  }
  const migrated = migration.migrateRecord(record);
  if (isWireMigrationRecordArray(migrated)) {
    throw new Error(`Migration ${migration.sourceVersion} returned multiple records`);
  }
  return updateMetadata(migration, migrated);
}

function updateMetadata(
  migration: WireMigration,
  record: WireMigrationRecord,
): WireMigrationRecord {
  if (record.type !== 'metadata') return record;
  return {
    ...record,
    protocol_version: migration.targetVersion,
  };
}

function isWireMigrationRecordArray(
  result: WireMigrationRecord | readonly WireMigrationRecord[],
): result is readonly WireMigrationRecord[] {
  return Array.isArray(result);
}

export function wireSnapshot(records: readonly WireMigrationRecord[]) {
  return eventSnapshot(
    records.map((record) => {
      const { type: event, ...args } = record;
      return {
        type: '[wire]' as const,
        event,
        args,
      };
    }),
    new Map(),
  );
}
