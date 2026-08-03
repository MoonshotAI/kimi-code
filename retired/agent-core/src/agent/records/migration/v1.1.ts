import type { WireMigration, WireMigrationRecord } from './index';

/**
 * Wire records before v1.1 used a nested `function` wrapper for each tool call:
 *   { function: { name: 'xxx', arguments: 'yyy' } }
 * v1.1 flattens it to:
 *   { name: 'xxx', arguments: 'yyy' }
 */
interface V1_0ContextAppendMessageRecord extends WireMigrationRecord {
  readonly type: 'context.append_message';
  readonly message: V1_0ContextMessage;
}

interface V1_0ContextMessage {
  readonly toolCalls: readonly V1_0ToolCall[];
  readonly [key: string]: unknown;
}

interface V1_0ToolCall {
  readonly type: 'function';
  readonly id: string;
  readonly function: {
    readonly name?: string;
    readonly arguments?: string | null;
  };
}

function migrateToolCall(toolCall: V1_0ToolCall): WireMigrationRecord {
  const { function: fn, ...rest } = toolCall;
  return {
    ...rest,
    name: fn.name,
    arguments: fn.arguments,
  };
}

export const migrateV1_0ToV1_1: WireMigration = {
  sourceVersion: '1.0',
  targetVersion: '1.1',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (record.type !== 'context.append_message') return record;
    const appendMessageRecord = record as V1_0ContextAppendMessageRecord;

    return {
      ...appendMessageRecord,
      message: {
        ...appendMessageRecord.message,
        toolCalls: appendMessageRecord.message.toolCalls.map(migrateToolCall),
      },
    };
  },
};
