import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const V2_WIRE_PROTOCOL_VERSION = '1.5';

export interface V2WireRecord {
  type: string;
  time?: number;
  [key: string]: unknown;
}

export class V2WireError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'V2WireError';
    this.code = code;
  }
}

const CONSUMED_TYPES = new Set([
  'context.append_message',
  'context.append_loop_event',
  'context.apply_compaction',
  'context.clear',
  'context.undo',
  'turn.prompt',
  'turn.cancel',
  'turn.ended',
  'llm.request',
  'tools.update_store',
]);

const TURN_END_REASONS = new Set(['completed', 'cancelled', 'failed', 'blocked']);

function compareWireVersions(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const maxLength = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLength; i++) {
    const diff = Number(partsA[i] ?? '0') - Number(partsB[i] ?? '0');
    if (diff !== 0) return diff;
  }
  return 0;
}

function migrateV1_0ToolCall(toolCall: unknown): unknown {
  if (typeof toolCall !== 'object' || toolCall === null || Array.isArray(toolCall)) return toolCall;
  const record = toolCall as Record<string, unknown>;
  const fn = record['function'];
  if (typeof fn !== 'object' || fn === null || Array.isArray(fn)) return toolCall;
  const { function: _fn, ...rest } = record;
  const fnRecord = fn as Record<string, unknown>;
  return { ...rest, name: fnRecord['name'], arguments: fnRecord['arguments'] };
}

function migrateV1_0Record(record: V2WireRecord): V2WireRecord {
  if (record.type !== 'context.append_message') return record;
  const message = record['message'];
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return record;
  const messageRecord = message as Record<string, unknown>;
  const toolCalls = messageRecord['toolCalls'];
  if (!Array.isArray(toolCalls)) return record;
  return { ...record, message: { ...messageRecord, toolCalls: toolCalls.map(migrateV1_0ToolCall) } };
}

function isValidCompactionRecord(record: V2WireRecord): boolean {
  if (typeof record['summary'] === 'string' && typeof record['compactedCount'] === 'number') {
    return true;
  }
  if (typeof record['contextSummary'] === 'string' && typeof record['compactedCount'] === 'number') {
    return true;
  }
  return 'summary' in record && typeof record['count'] === 'number';
}

function passesValidation(record: V2WireRecord): boolean {
  switch (record.type) {
    case 'context.undo': {
      const count = record['count'];
      return typeof count === 'number' && Number.isSafeInteger(count) && count > 0;
    }
    case 'context.apply_compaction':
      return isValidCompactionRecord(record);
    case 'turn.prompt': {
      const promptId = record['promptId'];
      return promptId === undefined || typeof promptId === 'string';
    }
    case 'turn.ended': {
      const turnId = record['turnId'];
      const reason = record['reason'];
      return (
        typeof turnId === 'number' &&
        typeof reason === 'string' &&
        TURN_END_REASONS.has(reason)
      );
    }
    case 'llm.request':
      return typeof record['provider'] === 'string' && typeof record['model'] === 'string';
    case 'tools.update_store':
      return typeof record['key'] === 'string';
    default:
      return true;
  }
}

export async function* readV2WireRecords(
  path: string,
  opts: { agentId: string },
): AsyncGenerator<V2WireRecord> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let version: string | undefined;
  let first = true;
  let migrate: (record: V2WireRecord) => V2WireRecord = (record) => record;
  for await (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      break;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) break;
    const record = value as V2WireRecord;
    if (typeof record.type !== 'string') break;
    if (first) {
      first = false;
      if (record.type === 'metadata') {
        const declared = record['protocol_version'];
        version = typeof declared === 'string' ? declared : V2_WIRE_PROTOCOL_VERSION;
        if (compareWireVersions(version, V2_WIRE_PROTOCOL_VERSION) > 0) {
          throw new V2WireError(
            'unsupported-wire-version',
            `wire protocol version ${version} is newer than supported ${V2_WIRE_PROTOCOL_VERSION}`,
          );
        }
        if (compareWireVersions(version, '1.1') < 0) {
          migrate = migrateV1_0Record;
        }
        continue;
      }
      version = '1.4';
    }
    if (record.type === 'metadata') continue;
    const migrated = migrate(record);
    if (!CONSUMED_TYPES.has(migrated.type)) continue;
    const agentId = migrated['agentId'];
    if (agentId === undefined) {
      migrated['agentId'] = opts.agentId;
    } else if (agentId !== opts.agentId) {
      continue;
    }
    if (!passesValidation(migrated)) continue;
    yield migrated;
  }
}
