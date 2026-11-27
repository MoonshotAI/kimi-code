import type { WireRecord } from './record';

const WIRE_TURN_CLOCK_ONLY = Symbol('wire.turn.clock-only');

export function markWireTurnClockOnly(record: WireRecord): WireRecord {
  return { ...record, [WIRE_TURN_CLOCK_ONLY]: true };
}

export function isWireTurnClockOnly(record: WireRecord): boolean {
  return (record as WireRecord & { readonly [WIRE_TURN_CLOCK_ONLY]?: boolean })[WIRE_TURN_CLOCK_ONLY] === true;
}

export interface WireTurnInputMatch {
  readonly appendIndex: number;
  readonly inputIndex?: number;
  readonly visibleTurnIndex: number;
  readonly turnId?: number;
}

export function matchWireTurnInputRecords(
  records: readonly WireRecord[],
  allUserMessages = false,
): WireTurnInputMatch[] {
  const inputIndices: number[] = [];
  const appends: {
    readonly record: WireRecord;
    readonly index: number;
    readonly visibleTurnIndex: number;
  }[] = [];
  const turnIds = new Map<number, number>();
  const cancelledTurnIds = new Set<number>();
  let currentTurnId: number | undefined;
  let nextTurnId = 0;
  let visibleTurnIndex = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (
      record.type === 'context.undo' ||
      record.type === 'context.clear' ||
      record.type === 'context.apply_compaction'
    ) {
      currentTurnId = undefined;
    }
    if (record.type === 'turn.cancel') {
      const turnId = record['turnId'];
      if (record['target'] !== undefined && typeof turnId === 'number' && turnId >= nextTurnId) {
        cancelledTurnIds.add(turnId);
        while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
      }
      continue;
    }
    if (record.type === 'turn.prompt') {
      const explicitTurnId = record['turnId'];
      const turnId = typeof explicitTurnId === 'number' ? explicitTurnId : nextTurnId;
      currentTurnId = turnId;
      turnIds.set(index, turnId);
      nextTurnId = Math.max(nextTurnId, turnId + 1);
      while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
    } else if (record.type === 'turn.steer') {
      const explicitTurnId = record['turnId'];
      const turnId = typeof explicitTurnId === 'number' ? explicitTurnId : currentTurnId;
      if (turnId !== undefined) turnIds.set(index, turnId);
    }
    const isInput = allUserMessages
      ? record.type === 'turn.prompt' || record.type === 'turn.steer'
      : isVisibleWireTurnInput(record);
    if (isInput && !isWireTurnClockOnly(record)) inputIndices.push(index);
    const isAppend = allUserMessages
      ? record.type === 'context.append_message' &&
        wireRecordObject(record['message'])?.['role'] === 'user'
      : isVisibleWireTurnAppend(record);
    if (!isAppend) continue;
    appends.push({ record, index, visibleTurnIndex });
    visibleTurnIndex += 1;
  }
  const unused = [...inputIndices];
  const matches: WireTurnInputMatch[] = [];
  for (const append of appends) {
    const exact = unused.findIndex(
      (index) =>
        (records[index]!.type !== 'turn.prompt' || index < append.index) &&
        wireTurnInputMatches(records[index]!, append.record, true, allUserMessages),
    );
    const matchAt = exact !== -1
      ? exact
      : unused.findIndex(
          (index) =>
            (records[index]!.type !== 'turn.prompt' || index < append.index) &&
            wireTurnInputMatches(records[index]!, append.record, false, allUserMessages),
        );
    const inputIndex = matchAt === -1 ? undefined : unused.splice(matchAt, 1)[0];
    matches.push({
      appendIndex: append.index,
      inputIndex,
      visibleTurnIndex: append.visibleTurnIndex,
      turnId: inputIndex === undefined ? undefined : turnIds.get(inputIndex),
    });
  }
  return matches;
}

function isVisibleWireTurnInput(record: WireRecord): boolean {
  if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return false;
  const origin = wireRecordObject(record['origin']);
  switch (origin?.['kind']) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return origin?.['trigger'] === 'user-slash';
    case 'shell_command':
      return origin?.['phase'] === 'input';
    default:
      return false;
  }
}

export function isVisibleWireTurnAppend(record: WireRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const message = wireRecordObject(record['message']);
  if (message === undefined || message['role'] !== 'user') return false;
  const origin = wireRecordObject(message['origin']);
  switch (origin?.['kind']) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return origin?.['trigger'] === 'user-slash';
    case 'shell_command':
      return origin?.['phase'] === 'input';
    default:
      return false;
  }
}

function wireTurnInputMatches(
  inputRecord: WireRecord,
  turnRecord: WireRecord,
  compareContent: boolean,
  anyOrigin: boolean,
): boolean {
  if (inputRecord.type !== 'turn.prompt' && inputRecord.type !== 'turn.steer') return false;
  if (turnRecord.type !== 'context.append_message') return false;
  const message = wireRecordObject(turnRecord['message']);
  if (message === undefined || message['role'] !== 'user') return false;
  if (!anyOrigin) {
    const inputKind = wireRecordObject(inputRecord['origin'])?.['kind'];
    if (typeof inputKind !== 'string') return false;
    const messageKind = wireRecordObject(message['origin'])?.['kind'];
    if (messageKind !== undefined && typeof messageKind !== 'string') return false;
    if (
      inputKind === 'user'
        ? messageKind !== undefined && messageKind !== 'user'
        : inputKind !== messageKind
    ) {
      return false;
    }
  }
  const messageId = typeof message['id'] === 'string' ? message['id'] : undefined;
  const steerMessageId =
    inputRecord.type === 'turn.steer' && typeof inputRecord['messageId'] === 'string'
      ? inputRecord['messageId']
      : undefined;
  if (steerMessageId !== undefined && messageId !== undefined) {
    return steerMessageId === messageId;
  }
  const promptId =
    inputRecord.type === 'turn.prompt' && typeof inputRecord['promptId'] === 'string'
      ? inputRecord['promptId']
      : undefined;
  if (promptId !== undefined && messageId !== undefined) return promptId === messageId;
  if (anyOrigin) {
    const inputKind = wireRecordObject(inputRecord['origin'])?.['kind'] ?? 'user';
    const messageKind = wireRecordObject(message['origin'])?.['kind'] ?? 'user';
    if (inputKind !== messageKind) return false;
  }
  return (
    !compareContent ||
    JSON.stringify(inputRecord['input']) === JSON.stringify(message['content'])
  );
}

export function wireRecordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
