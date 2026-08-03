import type {
  WireMigration,
  WireMigrationRecord,
} from '../../../../src/agent/records/migration';
import { eventSnapshot } from '../../harness/snapshots';

export function runMigration(
  migration: WireMigration,
  records: readonly WireMigrationRecord[],
) {
  return wireSnapshot(records.map((record) => migrateRecord(migration, record)));
}

function migrateRecord(
  migration: WireMigration,
  record: WireMigrationRecord,
): WireMigrationRecord {
  const migrated = migration.migrateRecord(record);
  if (record.type !== 'metadata') return migrated;
  return {
    ...migrated,
    protocol_version: migration.targetVersion,
  };
}

function wireSnapshot(records: readonly WireMigrationRecord[]) {
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
