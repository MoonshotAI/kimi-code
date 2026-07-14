import type { WireMigration, WireMigrationRecord } from './migration';

export const migrateV1_2ToV1_3: WireMigration = {
  sourceVersion: '1.2',
  targetVersion: '1.3',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
