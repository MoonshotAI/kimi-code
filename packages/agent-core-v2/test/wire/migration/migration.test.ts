import { describe, expect, it } from 'vitest';

import {
  migrateWireRecord,
  type WireMigration,
} from '#/wire/migration/migration';

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

  it('returns the record unchanged with an empty migrations list', () => {
    expect(migrateWireRecord({ type: 'metadata', protocol_version: '1.0' }, [])).toEqual({
      type: 'metadata',
      protocol_version: '1.0',
    });
  });

  it('passes through unknown record types unchanged', () => {
    const migrations: WireMigration[] = [
      {
        sourceVersion: '0.8',
        targetVersion: '0.9',
        migrateRecord: (record) => ({ ...record, migrated: true }),
      },
    ];
    const result = migrateWireRecord({ type: 'unknown.type', custom: 'data' }, migrations);
    expect(result).toMatchObject({ type: 'unknown.type', custom: 'data', migrated: true });
  });

  it('handles a record with no type field', () => {
    const migrations: WireMigration[] = [
      {
        sourceVersion: '0.8',
        targetVersion: '0.9',
        migrateRecord: (record) => ({ ...record, migrated: true }),
      },
    ];
    const result = migrateWireRecord({ custom: 'data' } as never, migrations);
    expect(result).toMatchObject({ custom: 'data', migrated: true });
  });

  it('propagates errors thrown by a migration function', () => {
    const migrations: WireMigration[] = [
      {
        sourceVersion: '0.8',
        targetVersion: '0.9',
        migrateRecord: () => {
          throw new Error('migration failure');
        },
      },
    ];
    expect(() => migrateWireRecord({ type: 'metadata' }, migrations)).toThrow('migration failure');
  });
});
