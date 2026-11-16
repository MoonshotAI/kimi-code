import type { ContentPart } from '@moonshot-ai/core/llm/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { TurnTrigger } from '@moonshot-ai/core/loop/contract/inbox';
import type { WireRecord } from '#/wire/record';
import type { WireLine } from '#/wire/tree/tree';

export interface TurnPromptAnchorInput {
  readonly origin?: PromptOrigin;
  readonly trigger?: TurnTrigger;
  readonly input?: readonly ContentPart[];
  readonly promptId?: string;
}

export interface TurnUndoAnchor {
  readonly turnId: number;
  readonly promptId?: string;
  readonly origin?: PromptOrigin;
  readonly input: readonly ContentPart[];
  readonly cutIndex: number;
}

export interface TurnUndoProjection {
  readonly anchors: readonly TurnUndoAnchor[];
  readonly stoppedAtCompaction: boolean;
}

export interface TurnUndoCut {
  readonly index: number;
  readonly line: number;
  readonly anchor: TurnUndoAnchor;
}

export interface TurnUndoCutResult extends TurnUndoProjection {
  readonly cut?: TurnUndoCut;
}

export function isValidUndoCount(count: number): boolean {
  return Number.isSafeInteger(count) && count > 0;
}

export function isUndoAnchorOrigin(origin: PromptOrigin | undefined): boolean {
  if (origin === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

export function isUndoAnchorTurnPrompt(prompt: TurnPromptAnchorInput): boolean {
  if (prompt.trigger === 'continue') return false;
  if (prompt.trigger === undefined && prompt.promptId === undefined && prompt.input?.length === 0) {
    return false;
  }
  return isUndoAnchorOrigin(prompt.origin);
}

export function projectTurnUndo(
  records: readonly WireLine[],
  pairedLegacyUndoLines: ReadonlySet<number> = new Set(),
): TurnUndoProjection {
  let anchors: TurnUndoAnchor[] = [];
  let stoppedAtCompaction = false;
  let nextTurnId = 0;
  const cancelledTurnIds = new Set<number>();
  for (let index = 0; index < records.length; index++) {
    const { record, line } = records[index]!;
    if (record.type === 'context.clear') {
      anchors = [];
      stoppedAtCompaction = false;
      continue;
    }
    if (record.type === 'context.apply_compaction') {
      anchors = [];
      stoppedAtCompaction = true;
      continue;
    }
    if (record.type === 'context.undo') {
      if (pairedLegacyUndoLines.has(line)) continue;
      const count = record['count'];
      if (typeof count !== 'number' || !isValidUndoCount(count) || count > anchors.length) continue;
      anchors = anchors.slice(0, anchors.length - count);
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
    if (record.type === 'turn.steer') {
      const turnId = nextTurnId;
      nextTurnId += 1;
      while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
      const promptIds = record['promptIds'];
      const promptId = typeof record['messageId'] === 'string'
        ? record['messageId']
        : Array.isArray(promptIds) && typeof promptIds[0] === 'string' ? promptIds[0] : undefined;
      const prompt = {
        origin: record['origin'] as PromptOrigin | undefined,
        trigger: 'notify' as const,
        input: Array.isArray(record['input']) ? record['input'] as readonly ContentPart[] : [],
        promptId,
      };
      if (!isUndoAnchorTurnPrompt(prompt)) continue;
      anchors.push({
        turnId,
        promptId,
        origin: prompt.origin,
        input: prompt.input,
        cutIndex: promptOwnedRecordStart(records, index, promptId),
      });
      continue;
    }
    if (record.type !== 'turn.prompt') continue;
    const explicitTurnId = record['turnId'];
    const turnId = typeof explicitTurnId === 'number' ? explicitTurnId : nextTurnId;
    nextTurnId = Math.max(nextTurnId, turnId + 1);
    while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
    const prompt = turnPromptInput(record);
    if (!isUndoAnchorTurnPrompt(prompt)) continue;
    const promptId = prompt.promptId;
    anchors.push({
      turnId,
      promptId,
      origin: prompt.origin,
      input: prompt.input ?? [],
      cutIndex: promptOwnedRecordStart(records, index, promptId),
    });
  }
  return { anchors, stoppedAtCompaction };
}

export function cutTurnUndo(
  records: readonly WireLine[],
  pairedLegacyUndoLines: ReadonlySet<number>,
  count: number,
): TurnUndoCutResult {
  const projection = projectTurnUndo(records, pairedLegacyUndoLines);
  if (!isValidUndoCount(count)) return projection;
  const anchor = projection.anchors[projection.anchors.length - count];
  if (anchor === undefined) return projection;
  return {
    ...projection,
    cut: {
      index: anchor.cutIndex,
      line: records[anchor.cutIndex]!.line - 1,
      anchor,
    },
  };
}

export function wireLinesOf(records: readonly WireRecord[]): WireLine[] {
  return records.map((record, index) => ({ record, line: index + 1 }));
}

function turnPromptInput(record: WireRecord): TurnPromptAnchorInput {
  const origin = record['origin'];
  const trigger = record['trigger'];
  const input = record['input'];
  const promptId = record['promptId'];
  return {
    origin: origin as PromptOrigin | undefined,
    trigger: trigger as TurnTrigger | undefined,
    input: Array.isArray(input) ? input as readonly ContentPart[] : [],
    promptId: typeof promptId === 'string' ? promptId : undefined,
  };
}

function promptOwnedRecordStart(
  records: readonly WireLine[],
  index: number,
  promptId: string | undefined,
): number {
  if (promptId === undefined) return index;
  let start = index;
  let includedInjection = false;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const record = records[cursor]!.record;
    if (record.type !== 'context.append_message') continue;
    const message = asRecord(record['message']);
    const origin = asRecord(message?.['origin']);
    const ownedMessage = message?.['id'] === promptId && message['role'] === 'user';
    const ownedInjection = origin?.['kind'] === 'injection' && origin['ownerPromptId'] === promptId;
    if (ownedMessage && includedInjection) break;
    if (!ownedMessage && !ownedInjection) break;
    start = cursor;
    includedInjection ||= ownedInjection;
  }
  return start;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
