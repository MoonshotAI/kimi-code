import type { WireMigration, WireMigrationRecord } from './migration';

export const migrateV1_4ToV1_5: WireMigration = {
  sourceVersion: '1.4',
  targetVersion: '1.5',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (!advancesActiveInterval(record)) return record;
    if (record['wallClockResumedAt'] !== undefined) return record;
    if (typeof record['time'] !== 'number') return record;
    return { ...record, wallClockResumedAt: record['time'] };
  },
};

function advancesActiveInterval(record: WireMigrationRecord): boolean {
  return (
    record.type === 'goal.create' ||
    (record.type === 'goal.update' &&
      (record['status'] === 'active' ||
        (record['status'] === undefined && typeof record['wallClockMs'] === 'number')))
  );
}
