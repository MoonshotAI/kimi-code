import { Error2, ErrorCodes } from '#/errors';
import { FILE_HISTORY_RECORD_PREFIX } from '#/features/fileHistory/fileHistoryOps';
import { isUserEntry } from '#human/agent/turn';
import { normalizeReplayedEntry } from '#/agent/contextMemory/loopEventFold';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import type { WireRecord } from '#/wire/record';

export interface MainTurnSlice {
  readonly records: readonly WireRecord[];
  readonly cutoffTime?: number;
  readonly lastPrompt?: string;
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
  const turnStarts: number[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (isUserVisibleTurnRecord(records[index]!)) turnStarts.push(index);
  }
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

function isUserVisibleTurnRecord(record: WireRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const raw = record['message'];
  if (raw === null || typeof raw !== 'object') return false;
  const entry = normalizeReplayedEntry(raw);
  if (!isUserEntry(entry)) return false;
  const origin = entry.meta?.origin;
  switch (origin?.kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return origin.trigger === 'user-slash';
    case 'shell_command':
      return origin.phase === 'input';
    default:
      return false;
  }
}

function isTurnInputRecordType(type: string): boolean {
  return type === 'turn.started' || type === 'turn.prompt' || type === 'turn.steer';
}

function isUserVisibleTurnInputRecord(record: WireRecord): boolean {
  if (!isTurnInputRecordType(record.type)) return false;
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
  const pending: number[] = [];
  const retained = new Set<number>();
  let visibleTurnIndex = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (isUserVisibleTurnInputRecord(record)) {
      pending.push(index);
      continue;
    }
    if (!isUserVisibleTurnRecord(record)) continue;

    const matchAt = findMatchingTurnInput(records, pending, record);
    if (matchAt !== -1) {
      const [inputIndex] = pending.splice(matchAt, 1);
      if (visibleTurnIndex <= turnIndex && inputIndex !== undefined) {
        retained.add(inputIndex);
      }
    }
    visibleTurnIndex += 1;
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
  if (!isTurnInputRecordType(inputRecord.type)) return false;
  if (turnRecord.type !== 'context.append_message') return false;
  const raw = turnRecord['message'];
  if (raw === null || typeof raw !== 'object') return false;
  const entry = normalizeReplayedEntry(raw);
  if (!isUserEntry(entry)) return false;
  const inputKind = asRecord(inputRecord['origin'])?.['kind'];
  if (typeof inputKind !== 'string') return false;
  const messageKind = entry.meta?.origin?.kind;
  if (messageKind !== undefined && typeof messageKind !== 'string') return false;
  if (!sameTurnOrigin(inputKind, messageKind)) return false;
  return (
    !compareContent ||
    JSON.stringify(inputRecord['input']) === JSON.stringify(entry.message.content)
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

function promptMetadataFromTurnRecord(record: WireRecord): string | undefined {
  if (record.type !== 'context.append_message') return undefined;
  const raw = record['message'];
  if (raw === null || typeof raw !== 'object') return undefined;
  const entry = normalizeReplayedEntry(raw);
  if (!isUserEntry(entry)) return undefined;
  const origin = entry.meta?.origin;
  if (origin?.kind === 'skill_activation') {
    if (typeof origin.skillName !== 'string') return undefined;
    return promptMetadataTextFromText(slashCommandText(`/${origin.skillName}`, origin.skillArgs));
  }
  if (origin?.kind === 'plugin_command') {
    if (typeof origin.pluginId !== 'string' || typeof origin.commandName !== 'string') {
      return undefined;
    }
    return promptMetadataTextFromText(
      slashCommandText(`/${origin.pluginId}:${origin.commandName}`, origin.commandArgs),
    );
  }
  const activations = origin?.kind === 'user' ? origin.skillActivations : undefined;
  const content = entry.message.content;
  const bundled = activations?.length ?? 0;
  return promptMetadataTextFromContentParts(
    bundled === 0 ? [...content] : content.slice(bundled),
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
