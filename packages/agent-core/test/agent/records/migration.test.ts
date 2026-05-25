import { describe, expect, it } from 'vitest';

import {
  migrateWireRecords,
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

  it('flattens legacy tool calls when migrating v1.0 records', () => {
    const migrated = migrateWireRecords(
      [
        {
          type: 'context.append_message',
          message: {
            role: 'assistant',
            toolCalls: [
              {
                type: 'function',
                id: 'call_legacy_bash',
                function: {
                  name: 'Bash',
                  arguments: '{"command":"pwd"}',
                },
              },
            ],
          },
        },
      ],
      '1.0',
    );

    const toolCall = (
      migrated[0]?.['message'] as {
        readonly toolCalls: readonly Record<string, unknown>[];
      }
    ).toolCalls[0];
    expect(toolCall).toMatchObject({
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    });
    expect(toolCall?.['function']).toBeUndefined();
  });
});
