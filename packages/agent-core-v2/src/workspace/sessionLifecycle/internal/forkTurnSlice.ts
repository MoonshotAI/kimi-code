/**
 * `sessionLifecycle` domain — fork-time turn truncation over raw wire records.
 *
 * Ports the v1 engine's `forkSession(turnIndex)` slicing onto the flat
 * `WireRecord` shape: a user-visible turn boundary is a
 * `context.append_message` user record with an interactive origin (plain user
 * input, a user-slash skill / plugin command, or a shell-command input line),
 * the retained main prefix runs through the addressed turn inclusive, and
 * `turn.prompt` / `turn.steer` inputs inside the prefix survive only when
 * matched (origin kind, then content exact-then-fuzzy) to a retained boundary.
 * Subagent wires time-cut at the retained main prefix's latest record time,
 * and the fork's `lastPrompt` re-derives from the addressed turn's record
 * through the `prompt` domain's shared metadata-text normalization. Pure
 * functions over already-read records — own no scoped state.
 */

import { Error2, ErrorCodes } from '#/errors';
import type { ContentPart } from '#/kosong/contract/message';
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
      (record, index) => !isUserVisibleTurnInputRecord(record) || retainedTurnInputs.has(index),
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
  if (inputRecord.type !== 'turn.prompt' && inputRecord.type !== 'turn.steer') return false;
  if (turnRecord.type !== 'context.append_message') return false;
  const message = asRecord(turnRecord['message']);
  if (message === undefined || message['role'] !== 'user') return false;
  const inputKind = asRecord(inputRecord['origin'])?.['kind'];
  if (typeof inputKind !== 'string') return false;
  const messageKind = asRecord(message['origin'])?.['kind'];
  if (messageKind !== undefined && typeof messageKind !== 'string') return false;
  if (!sameTurnOrigin(inputKind, messageKind)) return false;
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

function promptMetadataFromTurnRecord(record: WireRecord): string | undefined {
  if (record.type !== 'context.append_message') return undefined;
  const message = asRecord(record['message']);
  if (message === undefined || message['role'] !== 'user') return undefined;
  const origin = asRecord(message['origin']);
  if (origin?.['kind'] === 'skill_activation') {
    const name = origin['skillName'];
    if (typeof name !== 'string') return undefined;
    return promptMetadataTextFromText(slashCommandText(`/${name}`, origin['skillArgs']));
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
