import { Error2, ErrorCodes } from '#/errors';
import { FILE_HISTORY_RECORD_PREFIX } from '#/features/fileHistory/fileHistoryOps';
import type { ContentPart } from '#human/llm/message';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import type { WireRecord } from '#/wire/record';

export interface MainTurnSlice {
  readonly records: readonly WireRecord[];
  readonly cutoffTime?: number;
  readonly lastPrompt?: string;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export function assertForkTurnIndex(turnIndex: number | undefined): void {
  if (turnIndex === undefined) return;
  if (Number.isSafeInteger(turnIndex) && turnIndex >= 0) return;
  throw new Error2(
    ErrorCodes.REQUEST_INVALID,
    'forkSession turnIndex must be a non-negative safe integer',
    { details: { turnIndex } },
  );
}

export function sliceMainRecordsAtTurn(
  records: readonly WireRecord[],
  sourceSessionId: string,
  turnIndex: number,
): MainTurnSlice {
  const turnStarts = userVisibleTurnStartIndices(records);
  const start = turnStarts[turnIndex];
  if (start === undefined) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `Turn ${String(turnIndex)} was not found in session "${sourceSessionId}"`,
      { details: { turnIndex, availableTurns: turnStarts.length } },
    );
  }

  const end = turnStarts[turnIndex + 1] ?? records.length;
  const retainedTurnInputs = turnInputIndicesThrough(records, turnIndex);
  const retained = records
    .slice(0, end)
    .filter(
      (record, index) =>
        !record.type.startsWith(FILE_HISTORY_RECORD_PREFIX) &&
        (!isUserVisibleTurnInputRecord(record) || retainedTurnInputs.has(index)),
    );
  const cutoffTimes = retained
    .map(recordTime)
    .filter((time): time is number => time !== undefined);
  const lastPrompt = promptMetadataFromTurnRecord(records[start]!);
  return {
    records: retained,
    cutoffTime: cutoffTimes.length === 0 ? undefined : Math.max(...cutoffTimes),
    lastPrompt,
    lastTurnReason: turnOutcomeOfRecords(retained),
  };
}

export function sliceSubagentRecordsAtTime(
  records: readonly WireRecord[],
  cutoffTime: number | undefined,
): readonly WireRecord[] {
  if (cutoffTime === undefined) return [];
  let end = records.length;
  for (let index = 0; index < records.length; index += 1) {
    const time = recordTime(records[index]!);
    if (time !== undefined && time > cutoffTime) {
      end = index;
      break;
    }
  }
  return records.slice(0, end);
}

export function lastCompletedUserVisibleTurnIndex(
  records: readonly WireRecord[],
): number | undefined {
  const turnStarts = userVisibleTurnStartIndices(records);
  let lastCompleted: number | undefined;
  for (let start = 0; start < turnStarts.length; start += 1) {
    const from = turnStarts[start]! + 1;
    const to = turnStarts[start + 1] ?? records.length;
    if (turnCompletionAt(records, from, to, records[turnStarts[start]!]!) !== -1) {
      lastCompleted = start;
    }
  }
  return lastCompleted;
}

export function capForkRecordsAtActiveTurn(
  records: readonly WireRecord[],
  lastCompleted: number,
): readonly WireRecord[] {
  const turnStarts = userVisibleTurnStartIndices(records);
  const completedAt = turnCompletionAt(
    records,
    turnStarts[lastCompleted]! + 1,
    turnStarts[lastCompleted + 1] ?? records.length,
    records[turnStarts[lastCompleted]!]!,
  );
  if (completedAt === -1) return records;
  let openTurnStart = -1;
  let openShellInput = false;
  for (let index = completedAt + 1; index < records.length; index += 1) {
    const record = records[index]!;
    if (openTurnStart === -1) {
      if (isEngineTurnStartRecord(record) || isUserVisibleTurnRecord(record)) {
        openTurnStart = index;
        openShellInput = isShellCommandTurnStart(record);
      }
      continue;
    }
    if (record.type === 'turn.ended') {
      openTurnStart = -1;
      continue;
    }
    if (isShellCommandTurnStart(record)) {
      openShellInput = true;
      continue;
    }
    if (openShellInput && isShellCommandOutputRecord(record)) {
      openTurnStart = -1;
    }
  }
  return openTurnStart === -1 ? records : records.slice(0, openTurnStart);
}

export type ForkPromptResolution =
  | { readonly status: 'found'; readonly index: number }
  | { readonly status: 'unknown' }
  | { readonly status: 'ambiguous' };

export function resolveForkPromptIndex(
  records: readonly WireRecord[],
  promptId: string,
): ForkPromptResolution {
  const turnStarts = userVisibleTurnStartIndices(records);
  const targetIds = new Set<string>([promptId]);
  for (const record of records) {
    if (record.type !== 'turn.steer') continue;
    const promptIds = record['promptIds'];
    if (!Array.isArray(promptIds) || !promptIds.includes(promptId)) continue;
    const messageId = record['messageId'];
    if (typeof messageId === 'string' && messageId.length > 0) targetIds.add(messageId);
  }
  let found: number | undefined;
  let ambiguous = false;
  for (let start = 0; start < turnStarts.length; start += 1) {
    const message = asRecord(records[turnStarts[start]!]!['message']);
    const id = message?.['id'];
    if (typeof id !== 'string' || !targetIds.has(id)) continue;
    if (found !== undefined && found !== start) ambiguous = true;
    found = found ?? start;
  }
  if (ambiguous) return { status: 'ambiguous' };
  return found === undefined ? { status: 'unknown' } : { status: 'found', index: found };
}

function turnCompletionAt(
  records: readonly WireRecord[],
  from: number,
  to: number,
  startRecord: WireRecord,
): number {
  const shellStart = isShellCommandTurnStart(startRecord);
  for (let index = from; index < to; index += 1) {
    const record = records[index]!;
    if (record.type === 'turn.ended') return index;
    if (shellStart && isShellCommandOutputRecord(record)) return index;
  }
  return -1;
}

function isShellCommandTurnStart(record: WireRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const message = asRecord(record['message']);
  const origin = asRecord(message?.['origin']);
  return origin?.['kind'] === 'shell_command' && origin?.['phase'] === 'input';
}

function isShellCommandOutputRecord(record: WireRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const message = asRecord(record['message']);
  const origin = asRecord(message?.['origin']);
  return origin?.['kind'] === 'shell_command' && origin?.['phase'] === 'output';
}

function userVisibleTurnStartIndices(records: readonly WireRecord[]): number[] {
  const turnStarts: number[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (isUserVisibleTurnRecord(records[index]!)) turnStarts.push(index);
  }
  return turnStarts;
}

function isUserVisibleTurnRecord(record: WireRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const message = asRecord(record['message']);
  if (message === undefined || message['role'] !== 'user') return false;
  const origin = asRecord(message['origin']);
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

function isUserVisibleTurnInputRecord(record: WireRecord): boolean {
  if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return false;
  const origin = asRecord(record['origin']);
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

function turnInputIndicesThrough(
  records: readonly WireRecord[],
  turnIndex: number,
): ReadonlySet<number> {
  const inputIndices: number[] = [];
  const appends: { readonly record: WireRecord; readonly visibleTurnIndex: number }[] = [];
  let visibleTurnIndex = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (isUserVisibleTurnInputRecord(record)) {
      inputIndices.push(index);
      continue;
    }
    if (!isUserVisibleTurnRecord(record)) continue;
    appends.push({ record, visibleTurnIndex });
    visibleTurnIndex += 1;
  }
  const unused = [...inputIndices];
  const retained = new Set<number>();
  for (const append of appends) {
    const matchAt = findMatchingTurnInput(records, unused, append.record);
    if (matchAt === -1) continue;
    const [inputIndex] = unused.splice(matchAt, 1);
    if (append.visibleTurnIndex <= turnIndex && inputIndex !== undefined) {
      retained.add(inputIndex);
    }
  }
  return retained;
}

function findMatchingTurnInput(
  records: readonly WireRecord[],
  pending: readonly number[],
  turnRecord: WireRecord,
): number {
  const exact = pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]!, turnRecord, true),
  );
  if (exact !== -1) return exact;
  return pending.findIndex((index) => turnInputMatchesRecord(records[index]!, turnRecord, false));
}

function turnInputMatchesRecord(
  inputRecord: WireRecord,
  turnRecord: WireRecord,
  compareContent: boolean,
): boolean {
  if (inputRecord.type !== 'turn.prompt' && inputRecord.type !== 'turn.steer') return false;
  if (turnRecord.type !== 'context.append_message') return false;
  const message = asRecord(turnRecord['message']);
  if (message === undefined || message['role'] !== 'user') return false;
  const inputKind = asRecord(inputRecord['origin'])?.['kind'];
  if (typeof inputKind !== 'string') return false;
  const messageKind = asRecord(message['origin'])?.['kind'];
  if (messageKind !== undefined && typeof messageKind !== 'string') return false;
  if (!sameTurnOrigin(inputKind, messageKind)) return false;
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
  if (promptId !== undefined && messageId !== undefined) {
    return promptId === messageId;
  }
  return (
    !compareContent ||
    JSON.stringify(inputRecord['input']) === JSON.stringify(message['content'])
  );
}

function sameTurnOrigin(inputKind: string, messageKind: string | undefined): boolean {
  if (inputKind === 'user') return messageKind === undefined || messageKind === 'user';
  return inputKind === messageKind;
}

function recordTime(record: WireRecord): number | undefined {
  if (typeof record.time === 'number' && Number.isFinite(record.time)) return record.time;
  if (record.type === 'metadata') {
    const createdAt = record['created_at'];
    if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt;
  }
  return undefined;
}

function turnOutcomeOfRecords(
  records: readonly WireRecord[],
): 'completed' | 'cancelled' | 'failed' | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type === 'turn.ended') {
      const reason = record['reason'];
      if (reason === 'completed' || reason === 'cancelled') return reason;
      if (reason === 'failed' || reason === 'blocked') return 'failed';
      return undefined;
    }
    if (isEngineTurnStartRecord(record) || isUserVisibleTurnRecord(record)) return undefined;
  }
  return undefined;
}

function isEngineTurnStartRecord(record: WireRecord): boolean {
  return (
    record.type === 'turn.prompt' ||
    record.type === 'turn.steer' ||
    record.type === 'agent.turn.started'
  );
}

function promptMetadataFromTurnRecord(record: WireRecord): string | undefined {
  if (record.type !== 'context.append_message') return undefined;
  const message = asRecord(record['message']);
  if (message === undefined || message['role'] !== 'user') return undefined;
  const origin = asRecord(message['origin']);
  if (origin?.['kind'] === 'skill_activation') {
    const name = origin['skillName'];
    if (typeof name !== 'string') return undefined;
    return promptMetadataTextFromContentParts([{ type: 'text', text: slashCommandText(`/${name}`, origin['skillArgs']) }], origin['clientMetadata']);
  }
  if (origin?.['kind'] === 'plugin_command') {
    const pluginId = origin['pluginId'];
    const commandName = origin['commandName'];
    if (typeof pluginId !== 'string' || typeof commandName !== 'string') return undefined;
    return promptMetadataTextFromText(
      slashCommandText(`/${pluginId}:${commandName}`, origin['commandArgs']),
    );
  }
  const content = message['content'];
  if (!Array.isArray(content)) return undefined;
  const activations = origin?.['skillActivations'];
  const bundled = origin?.['kind'] === 'user' && Array.isArray(activations) ? activations.length : 0;
  return promptMetadataTextFromContentParts(
    (bundled === 0 ? content : content.slice(bundled)) as readonly ContentPart[],
    origin?.['kind'] === 'user' ? origin['clientMetadata'] : undefined,
  );
}

function slashCommandText(command: string, args: unknown): string {
  const trimmed = typeof args === 'string' ? args.trim() : undefined;
  return trimmed === undefined || trimmed.length === 0 ? command : `${command} ${trimmed}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
