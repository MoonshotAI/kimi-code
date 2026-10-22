import type { HistoryMessage, UserMeta } from '@moonshot-ai/agent-core/history/index';
import type { LoopRecord } from '@moonshot-ai/agent-core/loop/index';
import type { Entry } from '@moonshot-ai/agent-core/store/index';

export interface UndoAvailability {
  readonly maxTurns: number;
  readonly stoppedAtCompaction: boolean;
}

export function isUndoAnchor(message: HistoryMessage): boolean {
  if (message.message.role !== 'user') return false;
  const origin = (message.meta as UserMeta | undefined)?.origin;
  return origin === undefined || origin.kind === 'user';
}

export function isCompactionSummary(message: HistoryMessage): boolean {
  return message.meta?.source === 'compaction' && message.meta.key === 'summary';
}

export function computeUndoAvailability(messages: readonly HistoryMessage[]): UndoAvailability {
  let maxTurns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (isCompactionSummary(message)) {
      return { maxTurns, stoppedAtCompaction: true };
    }
    if (isUndoAnchor(message)) maxTurns += 1;
  }
  return { maxTurns, stoppedAtCompaction: false };
}

export function isValidUndoCount(count: number): boolean {
  return Number.isSafeInteger(count) && count > 0;
}

export type UndoFeatureErrorCode =
  | 'invalid-count'
  | 'busy-turn'
  | 'busy-compaction'
  | 'empty'
  | 'compaction-boundary'
  | 'insufficient';

export class UndoFeatureError extends Error {
  readonly code: UndoFeatureErrorCode;
  readonly requested?: number;
  readonly undoable?: number;

  constructor(
    code: UndoFeatureErrorCode,
    message: string,
    details?: { readonly requested?: number; readonly undoable?: number },
  ) {
    super(message);
    this.name = 'UndoFeatureError';
    this.code = code;
    this.requested = details?.requested;
    this.undoable = details?.undoable;
  }
}

export function undoInvalidCountError(): UndoFeatureError {
  return new UndoFeatureError('invalid-count', 'Undo count must be a positive safe integer');
}

export function undoBusyTurnError(): UndoFeatureError {
  return new UndoFeatureError(
    'busy-turn',
    'Cannot undo while a turn is active or queued. Wait for it to finish, then retry.',
  );
}

export function undoBusyCompactionError(): UndoFeatureError {
  return new UndoFeatureError(
    'busy-compaction',
    'Cannot undo while conversation compaction is running. Wait for it to finish, then retry.',
  );
}

export function undoEmptyError(): UndoFeatureError {
  return new UndoFeatureError('empty', 'Nothing to undo: no user message to undo');
}

export function undoCompactionBoundaryError(): UndoFeatureError {
  return new UndoFeatureError(
    'compaction-boundary',
    'Nothing to undo: would cross a compaction boundary',
  );
}

export function undoInsufficientError(requested: number, undoable: number): UndoFeatureError {
  return new UndoFeatureError(
    'insufficient',
    `Nothing to undo: only ${undoable} of ${requested} requested turn(s) available`,
    { requested, undoable },
  );
}

export type UndoCutPlan =
  | { readonly ok: true; readonly machineTurns: number; readonly fromTurnId?: number }
  | { readonly ok: false };

export function planUndoCut(
  entries: readonly Entry<LoopRecord>[],
  anchorCount: number,
): UndoCutPlan {
  let machineTurns = 0;
  let anchors = 0;
  let anchored = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const event = entries[i]!.event;
    if (event.type === 'turn.started') {
      machineTurns += 1;
      if (anchored) return { ok: true, machineTurns, fromTurnId: event.turnId };
      continue;
    }
    if (event.type === 'context.settled') {
      if (event.messages.some(isCompactionSummary)) return { ok: false };
      continue;
    }
    if (event.type !== 'message.appended' || anchored) continue;
    if (isCompactionSummary(event.entry)) return { ok: false };
    if (!isUndoAnchor(event.entry)) continue;
    anchors += 1;
    if (anchors === anchorCount) anchored = true;
  }
  if (anchored) return { ok: true, machineTurns, fromTurnId: undefined };
  return { ok: false };
}
