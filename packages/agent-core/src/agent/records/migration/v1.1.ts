import type { WireMigration, WireMigrationRecord } from './index';

/**
 * Wire records before v1.1 used a nested `function` wrapper for each tool call:
 *   { function: { name: 'xxx', arguments: 'yyy' } }
 * v1.1 flattens it to:
 *   { name: 'xxx', arguments: 'yyy' }
 */
interface LegacyToolCall {
  function?: {
    name?: string;
    arguments?: string;
  };
}

function isLegacyToolCall(v: unknown): v is LegacyToolCall {
  return (
    typeof v === 'object' &&
    v !== null &&
    'function' in v &&
    typeof (v as Record<string, unknown>)['function'] === 'object' &&
    (v as Record<string, unknown>)['function'] !== null
  );
}

function migrateToolCall(v: LegacyToolCall): unknown {
  const { function: fn, ...rest } = v;
  return {
    ...rest,
    name: fn?.name,
    arguments: fn?.arguments,
  };
}

/**
 * Recursively replace old-style ToolCall objects in a plain JSON value.
 * Operates in-place (mutable) for performance.
 */
function migrateLegacyToolCalls(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (isLegacyToolCall(item)) {
        value[i] = migrateToolCall(item);
      } else {
        migrateLegacyToolCalls(item);
      }
    }
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (isLegacyToolCall(v)) {
        obj[key] = migrateToolCall(v);
      } else {
        migrateLegacyToolCalls(v);
      }
    }
    return obj;
  }

  return value;
}

export const migrateV1_0ToV1_1: WireMigration = {
  sourceVersion: '1.0',
  targetVersion: '1.1',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return migrateLegacyToolCalls(structuredClone(record)) as WireMigrationRecord;
  },
};
