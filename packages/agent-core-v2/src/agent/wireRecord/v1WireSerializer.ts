/**
 * `wireRecord` domain (L4) — v1.4 wire serializer for the agent scope.
 *
 * Rewrites Agent-scope persisted records into the v1-compatible wire shape
 * while keeping live in-memory emissions native to v2.
 */

import type { PersistedRecord } from '#/wire/wireService';

const DROPPED_RECORD_TYPES: ReadonlySet<string> = new Set([
  'context_size.measured',
  'task.started',
  'task.terminated',
  'skill.activate',
  'cron.add',
  'cron.delete',
  'cron.cursor',
]);

export function serializeV1WireRecord(record: PersistedRecord): readonly PersistedRecord[] {
  if (DROPPED_RECORD_TYPES.has(record.type)) return [];
  const records = reshape(record);
  return records.map((out) => {
    if (out.type === 'metadata' || out['time'] !== undefined) return out;
    return { ...(out as Record<string, unknown>), time: Date.now() } as PersistedRecord;
  });
}

function reshape(record: PersistedRecord): readonly PersistedRecord[] {
  switch (record.type) {
    case 'metadata': {
      const out: Record<string, unknown> = { type: 'metadata' };
      for (const key of ['protocol_version', 'created_at', 'app_version', 'kimi_version', 'producer', 'resumed']) {
        if (record[key] !== undefined) out[key] = record[key];
      }
      return [out as PersistedRecord];
    }
    case 'context.append_message': {
      return [
        {
          ...record,
          message: stripMessageId(record['message']),
        } as PersistedRecord,
      ];
    }
    case 'context.splice': {
      const messages = record['messages'] as
        | readonly { role?: string; content?: unknown; origin?: { kind?: string } }[]
        | undefined;
      if (!Array.isArray(messages) || messages.length === 0) return [];
      const out: PersistedRecord[] = [];
      for (const message of messages) {
        if (message?.origin?.kind === 'injection') {
          out.push({ type: 'context.append_message', message: stripMessageId(message) });
        }
      }
      return out;
    }
    case 'todo.set':
      return [
        {
          type: 'tools.update_store',
          key: 'todo',
          value: record['todos'],
        },
      ];
    case 'plan_mode.enter':
    case 'plan_mode.exit':
    case 'plan_mode.cancel':
      return [
        {
          type: record.type,
          id: record['id'],
        },
      ];
    case 'context.apply_compaction': {
      const out: Record<string, unknown> = { type: 'context.apply_compaction' };
      for (const key of [
        'summary',
        'contextSummary',
        'compactedCount',
        'tokensBefore',
        'tokensAfter',
        'keptUserMessageCount',
        'keptHeadUserMessageCount',
        'droppedCount',
      ]) {
        if (record[key] !== undefined) out[key] = record[key];
      }
      return [out as PersistedRecord];
    }
    case 'usage.record': {
      const rest: Record<string, unknown> = { ...(record as Record<string, unknown>) };
      const context = rest['context'] as
        | { type?: string; requestKind?: string }
        | undefined;
      let usageScope = rest['usageScope'];
      if (usageScope === undefined && context !== undefined) {
        usageScope = context.type;
      }
      if (context?.type === 'operation' && context.requestKind === 'full_compaction') {
        usageScope = 'session';
      }
      delete rest['context'];
      delete rest['turnId'];
      return [
        {
          ...rest,
          type: 'usage.record',
          usageScope,
        } as PersistedRecord,
      ];
    }
    case 'turn.prompt': {
      if (record['input'] === undefined) return [];
      const out: Record<string, unknown> = {
        type: 'turn.prompt',
        input: record['input'],
        origin: record['origin'] ?? { kind: 'user' },
      };
      if (record['steer'] !== undefined) out['steer'] = record['steer'];
      return [out as PersistedRecord];
    }
    default:
      return [record];
  }
}

function stripMessageId(message: unknown): unknown {
  if (message === null || typeof message !== 'object') return message;
  const { id: _id, ...rest } = message as Record<string, unknown>;
  void _id;
  return rest;
}
