import type { WireMigration, WireMigrationRecord } from './index';

/**
 * Wire records before v1.1 used a nested `function` wrapper for each tool call:
 *   { function: { name: 'xxx', arguments: 'yyy' } }
 * v1.1 flattens it to:
 *   { name: 'xxx', arguments: 'yyy' }
 */
interface LegacyToolCall {
  type: 'function';
  id: string;
  function: {
    name?: string;
    arguments?: string | null;
  };
}

function isLegacyToolCall(v: unknown): v is LegacyToolCall {
  if (!isRecord(v)) return false;
  return v['type'] === 'function' && typeof v['id'] === 'string' && isRecord(v['function']);
}

function migrateToolCall(v: LegacyToolCall): unknown {
  const { function: fn, ...rest } = v;
  return {
    ...rest,
    name: fn.name,
    arguments: fn.arguments,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const migrateV1_0ToV1_1: WireMigration = {
  sourceVersion: '1.0',
  targetVersion: '1.1',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (record.type !== 'context.append_message') return record;

    const message = record['message'] as {
      readonly toolCalls: readonly unknown[];
    };

    let changed = false;
    const toolCalls = message.toolCalls.map((toolCall) => {
      if (!isLegacyToolCall(toolCall)) return toolCall;
      changed = true;
      return migrateToolCall(toolCall);
    });

    if (!changed) return record;

    return {
      ...record,
      message: {
        ...message,
        toolCalls,
      },
    };
  },
};
