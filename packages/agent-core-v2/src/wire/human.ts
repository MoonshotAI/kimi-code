import type { WireRecord } from './record';
import { AGENT_SWITCHED_TYPE } from './tree/tree';

export const HUMAN_AGENT_DOMAIN = 'agent';

export const AGENT_WIRE_RECORD_TYPES: ReadonlySet<string> = new Set([
  AGENT_SWITCHED_TYPE,
  'agent.message.appended',
  'agent.turn.started',
  'agent.turn.ended',
  'agent.input.submitted',
  'agent.input.notified',
  'agent.input.reminded',
  'agent.input.steered',
  'agent.input.cancelled',
  'agent.queue.drained',
  'agent.input.drained',
  'agent.notifications.drained',
  'context.append_message',
  'context.append_loop_event',
  'context.apply_compaction',
  'context.clear',
  'context.undo',
  'context.undone',
  'turn.prompt',
  'turn.steer',
  'turn.cancel',
  'turn.ended',
]);

const LEGACY_HUMAN_RECORD_PREFIX = 'human.';
const WIRE_TURN_CLOCK_ONLY = Symbol('wire.turn.clock-only');

export function markWireTurnClockOnly(record: WireRecord): WireRecord {
  return { ...record, [WIRE_TURN_CLOCK_ONLY]: true };
}

export function isWireTurnClockOnly(record: WireRecord): boolean {
  return (record as WireRecord & { readonly [WIRE_TURN_CLOCK_ONLY]?: boolean })[WIRE_TURN_CLOCK_ONLY] === true;
}

export function isHumanRecordType(type: string): boolean {
  return AGENT_WIRE_RECORD_TYPES.has(type) || type.startsWith(LEGACY_HUMAN_RECORD_PREFIX);
}

export function humanRecordType(domain: string, type: string): string {
  return `${domain}.${type}`;
}

export function humanEventType(recordType: string, domain: string): string | undefined {
  if (recordType === AGENT_SWITCHED_TYPE) return undefined;
  for (const prefix of [`${domain}.`, `${LEGACY_HUMAN_RECORD_PREFIX}${domain}.`]) {
    if (!recordType.startsWith(prefix)) continue;
    const type = recordType.slice(prefix.length);
    return type.length === 0 ? undefined : type;
  }
  return undefined;
}

interface LegacyTurnSegment {
  readonly sourceTurnId: number;
  readonly turnId: number;
  readonly steps: Map<number, number>;
}

function legacySteerAppendMatches(steer: WireRecord, candidate?: WireRecord): boolean {
  if (candidate?.type !== 'context.append_message') return false;
  const value = candidate['message'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message['role'] !== 'user') return false;
  const messageId = typeof message['id'] === 'string' ? message['id'] : undefined;
  const steerMessageId = typeof steer['messageId'] === 'string' ? steer['messageId'] : undefined;
  if (messageId !== undefined && steerMessageId !== undefined) return messageId === steerMessageId;
  return JSON.stringify(message['content']) === JSON.stringify(steer['input']);
}

export function normalizeLegacyTurnSteerRecords(records: readonly WireRecord[]): WireRecord[] {
  const normalized: WireRecord[] = [];
  const segments = new Map<number, LegacyTurnSegment>();
  const cancelledTurnIds = new Set<number>();
  let active: LegacyTurnSegment | undefined;
  let nextTurnId = 0;

  const recordTurnId = (record: WireRecord): number | undefined => {
    const value = record['turnId'];
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
  };
  const startTurn = (sourceTurnId: number, record: WireRecord): void => {
    const turnId = Math.max(nextTurnId, recordTurnId(record) ?? 0);
    nextTurnId = turnId + 1;
    active = { sourceTurnId, turnId, steps: new Map() };
    segments.set(sourceTurnId, active);
    normalized.push({ ...record, turnId });
  };

  const moveLegacySteerBeforeAppend = (index: number, generatedCount: number): void => {
    if (legacySteerAppendMatches(records[index]!, records[index + 1])) return;
    if (!legacySteerAppendMatches(records[index]!, records[index - 1])) return;
    const generated = normalized.splice(-generatedCount, generatedCount);
    normalized.splice(normalized.length - 1, 0, ...generated);
  };

  for (const [index, record] of records.entries()) {
    if (record.type === 'turn.prompt') {
      startTurn(recordTurnId(record) ?? nextTurnId, record);
      continue;
    }
    if (record.type === 'turn.steer') {
      const sourceTurnId = recordTurnId(record) ?? active?.sourceTurnId;
      const current = sourceTurnId === undefined ? active : segments.get(sourceTurnId);
      if (current === undefined) {
        const turnId = sourceTurnId ?? nextTurnId;
        const promptIds = record['promptIds'];
        const firstPromptId = Array.isArray(promptIds) && typeof promptIds[0] === 'string' ? promptIds[0] : undefined;
        startTurn(turnId, {
          type: 'turn.prompt',
          agentId: record['agentId'],
          input: record['input'],
          origin: record['origin'],
          promptId: typeof record['messageId'] === 'string' ? record['messageId'] : firstPromptId,
          turnId,
          trigger: 'notify',
          time: record.time,
        });
      } else {
        const endedTurnId = current.turnId ?? sourceTurnId;
        normalized.push({
          type: 'turn.ended',
          agentId: record['agentId'],
          turnId: endedTurnId,
          reason: 'completed',
          time: record.time,
        });
        if (endedTurnId !== undefined) nextTurnId = Math.max(nextTurnId, endedTurnId + 1);
        const promptIds = record['promptIds'];
        const firstPromptId = Array.isArray(promptIds) && typeof promptIds[0] === 'string' ? promptIds[0] : undefined;
        startTurn(sourceTurnId ?? nextTurnId, {
          type: 'turn.prompt',
          agentId: record['agentId'],
          input: record['input'],
          origin: record['origin'],
          promptId: typeof record['messageId'] === 'string' ? record['messageId'] : firstPromptId,
          turnId: nextTurnId,
          trigger: 'notify',
          time: record.time,
        });
      }
      moveLegacySteerBeforeAppend(index, current === undefined ? 1 : 2);
      continue;
    }
    if (record.type === 'turn.ended') {
      const sourceTurnId = recordTurnId(record);
      const segment = sourceTurnId === undefined ? active : segments.get(sourceTurnId);
      const turnId = segment?.turnId ?? sourceTurnId;
      normalized.push({ ...record, turnId });
      if (turnId !== undefined) nextTurnId = Math.max(nextTurnId, turnId + 1);
      if (sourceTurnId === undefined || active === segment) active = undefined;
      continue;
    }
    if (record.type === 'turn.cancel') {
      const sourceTurnId = recordTurnId(record);
      const segment = sourceTurnId === undefined ? active : segments.get(sourceTurnId);
      const turnId = segment?.turnId ?? sourceTurnId;
      if (record['target'] !== undefined && typeof turnId === 'number' && turnId >= nextTurnId) {
        cancelledTurnIds.add(turnId);
        while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
      }
      normalized.push(segment === undefined ? record : { ...record, turnId: segment.turnId });
      continue;
    }
    if (record.type === 'context.append_loop_event') {
      const event = record['event'];
      if (typeof event !== 'object' || event === null || Array.isArray(event)) {
        normalized.push(record);
        continue;
      }
      const value = event as Record<string, unknown>;
      const sourceTurnId = typeof value['turnId'] === 'string' ? Number.parseInt(value['turnId'], 10) : Number.NaN;
      const segment = Number.isInteger(sourceTurnId) ? segments.get(sourceTurnId) : undefined;
      if (segment === undefined) {
        normalized.push(record);
        continue;
      }
      const sourceStep = typeof value['step'] === 'number' && Number.isInteger(value['step']) ? value['step'] : undefined;
      let step = sourceStep;
      if (sourceStep !== undefined) {
        step = segment.steps.get(sourceStep);
        if (step === undefined) {
          step = segment.steps.size + 1;
          segment.steps.set(sourceStep, step);
        }
      }
      normalized.push({
        ...record,
        event: { ...value, turnId: String(segment.turnId), step },
      });
      nextTurnId = Math.max(nextTurnId, segment.turnId + 1);
      continue;
    }
    normalized.push(record);
  }
  return normalized;
}
