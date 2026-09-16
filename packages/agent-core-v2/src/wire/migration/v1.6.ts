import type { WireMigration, WireMigrationRecord } from './migration';

export const migrateV1_5ToV1_6: WireMigration = {
  sourceVersion: '1.5',
  targetVersion: '1.6',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
