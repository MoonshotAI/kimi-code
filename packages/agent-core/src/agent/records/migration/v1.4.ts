import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.3 -> v1.4 is a bump-only migration.
 *
 * v1.4 introduces persisted goal lifecycle records (`goal.set`,
 * `goal.status`, and `goal.clear`). Existing records do not need
 * transformation, but the protocol bump lets older builds warn before
 * replaying sessions that may contain unsupported goal state.
 */
export const migrateV1_3ToV1_4: WireMigration = {
  sourceVersion: '1.3',
  targetVersion: '1.4',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
