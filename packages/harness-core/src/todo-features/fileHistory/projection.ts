import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/runtime/index';

import type {
  FileBackupEntry,
  FileHistoryCheckpointPhase,
  FileHistoryCheckpointRecord,
  FileHistoryState,
} from './fileHistory';

export const FILE_HISTORY_TURN_WINDOW = 5;
export const FILE_HISTORY_TRACKED = 'file_history.tracked';
export const FILE_HISTORY_CHECKPOINT = 'file_history.checkpoint';

export interface FileHistoryTrackedEvent extends FeatureEvent {
  readonly type: typeof FILE_HISTORY_TRACKED;
  readonly turn: number;
  readonly path: string;
  readonly entry: FileBackupEntry;
}

export interface FileHistoryCheckpointEvent extends FeatureEvent {
  readonly type: typeof FILE_HISTORY_CHECKPOINT;
  readonly turn: number;
  readonly phase: FileHistoryCheckpointPhase;
  readonly entries: Readonly<Record<string, FileBackupEntry>>;
}

export type FileHistoryEvent = FileHistoryTrackedEvent | FileHistoryCheckpointEvent;

export function checkpointPhaseOf(record: {
  readonly phase?: FileHistoryCheckpointPhase;
}): FileHistoryCheckpointPhase {
  return record.phase ?? 'start';
}

export function displacedCheckpoints<
  T extends { readonly turnId: number; readonly phase?: FileHistoryCheckpointPhase },
>(checkpoints: readonly T[], completingTurnId?: number): readonly T[] {
  const completedIds = [
    ...new Set([
      ...checkpoints.filter((c) => checkpointPhaseOf(c) === 'end').map((c) => c.turnId),
      ...(completingTurnId === undefined ? [] : [completingTurnId]),
    ]),
  ].toSorted((a, b) => b - a);
  if (completedIds.length <= FILE_HISTORY_TURN_WINDOW) return [];
  const keep = new Set(completedIds.slice(0, FILE_HISTORY_TURN_WINDOW));
  return checkpoints.filter((c) => !keep.has(c.turnId) && c.turnId <= completedIds[0]!);
}

function cloneEntries(
  entries: Readonly<Record<string, FileBackupEntry>>,
): Record<string, FileBackupEntry> {
  const clone: Record<string, FileBackupEntry> = Object.create(null) as Record<
    string,
    FileBackupEntry
  >;
  for (const [path, entry] of Object.entries(entries)) clone[path] = entry;
  return clone;
}

export const fileHistoryProjection: Projection<FileHistoryState, FileHistoryEvent> = {
  initial: () => ({ checkpoints: [], tracked: [] }),
  reduce: (state, { event }) => {
    if (event.type === FILE_HISTORY_CHECKPOINT) {
      const turnId = event.turn;
      const phase = checkpointPhaseOf(event);
      const existing = state.checkpoints.find(
        (c) => c.turnId === turnId && checkpointPhaseOf(c) === phase,
      );
      let checkpoints: readonly FileHistoryCheckpointRecord[];
      if (existing !== undefined) {
        const replacement: FileHistoryCheckpointRecord = {
          turnId,
          phase,
          entries: cloneEntries(event.entries),
        };
        checkpoints = state.checkpoints.map((c) => (c === existing ? replacement : c));
      } else {
        checkpoints = [
          ...state.checkpoints,
          { turnId, phase, entries: cloneEntries(event.entries) },
        ];
      }
      const displaced = new Set(displacedCheckpoints(checkpoints));
      if (displaced.size === 0) return { checkpoints, tracked: state.tracked };
      checkpoints = checkpoints.filter((c) => !displaced.has(c));
      const kept = new Set<string>();
      for (const checkpoint of checkpoints) {
        for (const path of Object.keys(checkpoint.entries)) kept.add(path);
      }
      return {
        checkpoints,
        tracked: state.tracked.filter((path) => kept.has(path)),
      };
    }
    if (event.type === FILE_HISTORY_TRACKED) {
      const turnId = event.turn;
      const tracked = state.tracked.includes(event.path)
        ? state.tracked
        : [...state.tracked, event.path];
      const existing = state.checkpoints.find(
        (c) => c.turnId === turnId && checkpointPhaseOf(c) === 'start',
      );
      if (existing !== undefined && Object.hasOwn(existing.entries, event.path)) {
        if (tracked === state.tracked) return state;
        return { checkpoints: state.checkpoints, tracked };
      }
      const nextEntries = cloneEntries(existing?.entries ?? {});
      nextEntries[event.path] = { ...event.entry };
      const record: FileHistoryCheckpointRecord = {
        turnId,
        phase: 'start',
        entries: nextEntries,
      };
      const checkpoints =
        existing === undefined
          ? [...state.checkpoints, record]
          : state.checkpoints.map((c) => (c === existing ? record : c));
      return { checkpoints, tracked };
    }
    return state;
  },
};
