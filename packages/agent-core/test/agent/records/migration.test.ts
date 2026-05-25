import { describe, expect, it } from 'vitest';

import {
  migrateWireRecord,
  type WireMigration,
} from '../../../src/agent/records/migration';

describe('wire record migrations', () => {
  it('applies migrations in order', () => {
    const migrations: WireMigration[] = [
      {
        sourceVersion: '0.8',
        targetVersion: '0.9',
        migrateRecord: (record) => ({
          ...record,
          first: true,
        }),
      },
      {
        sourceVersion: '0.9',
        targetVersion: '1.0',
        migrateRecord: (record) => ({
          ...record,
          second: record['first'] === true,
        }),
      },
    ];

    expect(migrateWireRecord({ type: 'metadata' }, migrations)).toEqual({
      type: 'metadata',
      first: true,
      second: true,
    });
  });
});
