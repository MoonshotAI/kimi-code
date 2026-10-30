import { Error2, ErrorCodes } from '#/errors';
import { FILE_HISTORY_RECORD_PREFIX } from '#/features/fileHistory/fileHistoryOps';
import { isUserPromptSubmitHookPart } from '#/agent/contextMemory/hookParts';
import {
  annotateBundledSkillParts,
  isSkillActivationPart,
  type BundledSkillActivation,
} from '#human/agent/origin';
import type { ContentPart } from '#human/llm/message';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import { matchWireTurnInputRecords } from '#/agent/replayBuilder/fold';
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

export function sliceRecordsBeforePendingWork(
  records: readonly WireRecord[],
  turnId: number | undefined,
  queuedPromptIds: readonly string[],
): readonly WireRecord[] {
  const turnEnd = turnId === undefined ? -1 : records.findIndex(
    (record) =>
      (record.type === 'agent.turn.started' || record.type === 'turn.prompt') &&
      record['turnId'] === turnId,
  );
  if (turnId !== undefined && turnEnd === -1) {
    throw new Error2(
      ErrorCodes.INTERNAL,
      `The active turn ${String(turnId)} boundary was not found in the session wire`,
      { details: { turnId } },
    );
  }
  const queued = new Set(queuedPromptIds);
  const queueEnd = queued.size === 0 ? -1 : records.findIndex((record) => {
    if (record.type !== 'agent.input.submitted') return false;
    const entry = asRecord(record['entry']);
    const meta = asRecord(entry?.['meta']);
    const promptId = meta?.['promptId'] ?? record['id'];
    return typeof promptId === 'string' && queued.has(promptId);
  });
  const end = turnEnd === -1
    ? queueEnd
    : queueEnd === -1
      ? turnEnd
      : Math.min(turnEnd, queueEnd);
  return end === -1 ? records : records.slice(0, end);
}

export function sliceMainRecordsAtLatestTurn(
  records: readonly WireRecord[],
  sourceSessionId: string,
): MainTurnSlice {
  const turns = persistentTurnStarts(records);
  const legacyTurns = contextOnlyTurnStarts(records);
  const latest = turns.at(-1);
  const latestLegacy = legacyTurns.at(-1);
  if (latestLegacy !== undefined && (latest === undefined || latestLegacy.start > latest.start)) {
    return sliceMainRecordsAtLegacyTurn(records, sourceSessionId, latestLegacy.turnIndex);
  }
  if (latest !== undefined) return sliceMainRecordsAtTurn(records, sourceSessionId, latest.id);
  return { records: [] };
}

export function sliceMainRecordsForRunningFork(
  records: readonly WireRecord[],
  sourceSessionId: string,
  activeTurnId: number | undefined,
  queuedPromptIds: readonly string[],
): MainTurnSlice {
  const completed = sliceRecordsBeforePendingWork(records, activeTurnId, queuedPromptIds);
  const latest = sliceMainRecordsAtLatestTurn(completed, sourceSessionId);
  if (activeTurnId === undefined) return latest;
  const promptIndex = records.findIndex(
    (record) => record.type === 'turn.prompt' && record['turnId'] === activeTurnId,
  );
  if (promptIndex === -1) return latest;
  const prompt = records[promptIndex]!;
  const match = matchWireTurnInputRecords(records, true).find(
    (candidate) => candidate.inputIndex === promptIndex && candidate.turnId === activeTurnId,
  );
  const append = match === undefined ? userMessageRecordFromPrompt(prompt) : records[match.appendIndex]!;
  return {
    records: [
      ...latest.records,
      prompt,
      append,
      {
        type: 'turn.ended',
        agentId: 'main',
        turnId: activeTurnId,
        reason: 'cancelled',
        time: Date.now(),
      },
    ],
    cutoffTime: latest.cutoffTime,
    lastPrompt: promptMetadataFromTurnRecord(prompt),
    lastTurnReason: 'cancelled',
  };
}

function userMessageRecordFromPrompt(prompt: WireRecord): WireRecord {
  const promptId = prompt['promptId'];
  return {
    type: 'context.append_message',
    message: {
      role: 'user',
      id: typeof promptId === 'string' ? promptId : undefined,
      content: prompt['input'],
      origin: prompt['origin'],
    },
    time: prompt.time,
  };
}

export function sliceMainRecordsAtTurn(
  records: readonly WireRecord[],
  sourceSessionId: string,
  turnIndex: number,
): MainTurnSlice {
  const turns = persistentTurnStarts(records);
  const legacyTurns = contextOnlyTurnStarts(records);
  const selected = turns.find((turn) => turn.id === turnIndex);
  if (selected === undefined) {
    if (legacyTurns.some((turn) => turn.turnIndex === turnIndex)) {
      return sliceMainRecordsAtLegacyTurn(records, sourceSessionId, turnIndex);
    }
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `Turn ${String(turnIndex)} was not found in session "${sourceSessionId}"`,
      { details: { turnIndex, availableTurns: turns.length + legacyTurns.length } },
    );
  }
  const next = turns.find((turn) => turn.start > selected.start);
  const nextLegacy = legacyTurns.find((turn) => turn.start > selected.start);
  const end = Math.min(next?.start ?? records.length, nextLegacy?.start ?? records.length);
  const retainedTurnIds = new Set(
    turns.filter((turn) => turn.start < end).map((turn) => turn.id),
  );
  const persistentByPromptIndex = new Map(turns.map((turn) => [turn.promptIndex, turn.id]));
  let visibleTurnCount = 0;
  for (let index = 0; index < end; index += 1) {
    if (isUserVisibleTurnRecord(records[index]!)) visibleTurnCount += 1;
  }
  const retainedTurnInputs = turnInputIndicesThrough(records, visibleTurnCount - 1);
  const retained = records
    .slice(0, end)
    .filter((record, index) => {
      if (record.type.startsWith(FILE_HISTORY_RECORD_PREFIX)) return false;
      if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return true;
      const turnId = record['turnId'];
      if (typeof turnId === 'number') return retainedTurnIds.has(turnId);
      const persistentTurnId = persistentByPromptIndex.get(index);
      return persistentTurnId === undefined
        ? retainedTurnInputs.has(index)
        : retainedTurnIds.has(persistentTurnId);
    });
  const cutoffTimes = retained
    .map(recordTime)
    .filter((time): time is number => time !== undefined);
  return {
    records: retained,
    cutoffTime: cutoffTimes.length === 0 ? undefined : Math.max(...cutoffTimes),
    lastPrompt: promptMetadataFromTurnRecord(records[selected.promptIndex]!),
    lastTurnReason: lastTurnReasonOf(retained),
  };
}

function sliceMainRecordsAtLegacyTurn(
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

  const nextPersistent = persistentTurnStarts(records).find((turn) => turn.start > start);
  const end = Math.min(
    turnStarts[turnIndex + 1] ?? records.length,
    nextPersistent?.start ?? records.length,
  );
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
    lastTurnReason: lastTurnReasonOf(retained),
  };
}

interface LegacyTurnStart {
  readonly start: number;
  readonly turnIndex: number;
}

interface PersistentTurnStart {
  readonly id: number;
  readonly start: number;
  readonly promptIndex: number;
}

function contextOnlyTurnStarts(records: readonly WireRecord[]): LegacyTurnStart[] {
  return matchWireTurnInputRecords(records).flatMap((match) =>
    match.inputIndex === undefined
      ? [{ start: match.appendIndex, turnIndex: match.visibleTurnIndex }]
      : [],
  );
}

function persistentTurnStarts(records: readonly WireRecord[]): PersistentTurnStart[] {
  const turns: (PersistentTurnStart & { start: number })[] = [];
  const humanStarts = new Map<number, number>();
  const terminalTurnIds = new Set<number>();
  const cancelledTurnIds = new Set<number>();
  let nextTurnId = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.type === 'agent.turn.started') {
      const turnId = record['turnId'];
      if (typeof turnId === 'number') {
        humanStarts.set(turnId, Math.min(humanStarts.get(turnId) ?? index, index));
        const existing = turns.find((turn) => turn.id === turnId);
        if (existing !== undefined) existing.start = Math.min(existing.start, index);
      }
      continue;
    }
    if (record.type === 'turn.ended' || record.type === 'agent.turn.ended') {
      const turnId = record['turnId'];
      if (typeof turnId === 'number') terminalTurnIds.add(turnId);
      continue;
    }
    if (record.type === 'turn.cancel') {
      const turnId = record['turnId'];
      if (record['target'] !== undefined && typeof turnId === 'number' && turnId >= nextTurnId) {
        cancelledTurnIds.add(turnId);
        while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
      }
      continue;
    }
    if (record.type !== 'turn.prompt') continue;
    const explicitTurnId = record['turnId'];
    const id = typeof explicitTurnId === 'number' ? explicitTurnId : nextTurnId;
    nextTurnId = Math.max(nextTurnId, id + 1);
    while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
    turns.push({ id, start: Math.min(index, humanStarts.get(id) ?? index), promptIndex: index });
  }
  const retainedTurnInputs = turnInputIndicesThrough(records, Number.MAX_SAFE_INTEGER);
  return turns.filter(
    (turn) => retainedTurnInputs.has(turn.promptIndex) || terminalTurnIds.has(turn.id),
  );
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

function lastTurnReasonOf(
  records: readonly WireRecord[],
): 'completed' | 'cancelled' | 'failed' | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type === 'turn.ended') {
      const reason = record['reason'];
      if (reason === 'completed' || reason === 'cancelled') return reason;
      if (reason === 'failed' || reason === 'blocked') return 'failed';
    }
    if (record.type === 'agent.turn.ended') {
      const outcome = record['outcome'];
      if (outcome === 'done') return 'completed';
      if (outcome === 'aborted') return 'cancelled';
      if (outcome === 'failed') return 'failed';
    }
  }
  return undefined;
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
  const retained = new Set<number>();
  for (const match of matchWireTurnInputRecords(records)) {
    if (match.visibleTurnIndex <= turnIndex && match.inputIndex !== undefined) {
      retained.add(match.inputIndex);
    }
  }
  return retained;
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
  if (record.type === 'turn.prompt') {
    return promptMetadataFromInput(record['input'], asRecord(record['origin']));
  }
  if (record.type !== 'context.append_message') return undefined;
  const message = asRecord(record['message']);
  if (message === undefined || message['role'] !== 'user') return undefined;
  return promptMetadataFromInput(message['content'], asRecord(message['origin']));
}

function promptMetadataFromInput(
  content: unknown,
  origin: Record<string, unknown> | undefined,
): string | undefined {
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
  if (!Array.isArray(content)) return undefined;
  const activations = origin?.['skillActivations'];
  const bundled =
    origin?.['kind'] === 'user' && Array.isArray(activations)
      ? (activations as BundledSkillActivation[])
      : [];
  return promptMetadataTextFromContentParts(
    annotateBundledSkillParts(content as readonly ContentPart[], bundled).filter(
      (part) => !isSkillActivationPart(part) && !isUserPromptSubmitHookPart(part),
    ),
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
