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
    // Recursively replace old-style ToolCall objects in-place.
    const migrate = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (isLegacyToolCall(item)) {
            value[i] = migrateToolCall(item);
          } else {
            migrate(item);
          }
        }
        return value;
      }

      if (isRecord(value)) {
        for (const key of Object.keys(value)) {
          const v = value[key];
          if (isLegacyToolCall(v)) {
            value[key] = migrateToolCall(v);
          } else {
            migrate(v);
          }
        }
      }

      return value;
    };

    return migrate(record) as WireMigrationRecord;
  },
};
