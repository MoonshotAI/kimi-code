/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type {
  FileBackupEntry,
  FileHistoryCheckpointPhase,
  FileHistoryState,
} from './fileHistory';

export const FILE_HISTORY_TURN_WINDOW = 5;
export const FILE_HISTORY_RECORD_PREFIX = 'file_history.';

const backupEntrySchema = z.object({
  key: z.string().nullable(),
  version: z.number(),
  contentHash: z.string().optional(),
  size: z.number().optional(),
  oversize: z.boolean().optional(),
  mtimeMs: z.number().optional(),
});

const fileHistoryTrackedSchema = z.object({
  agentId: z.string(),
  turnId: z.number(),
  path: z.string(),
  entry: backupEntrySchema,
});

export class FileHistoryTracked extends AgentEvent2<z.infer<typeof fileHistoryTrackedSchema>> {
  static override readonly type = 'file_history.tracked';
  static override readonly durable = true;
  static override readonly schema = fileHistoryTrackedSchema;
}
export interface FileHistoryTracked {
  readonly agentId: string;
  readonly turnId: number;
  readonly path: string;
  readonly entry: FileBackupEntry;
}

const fileHistoryCheckpointedSchema = z.object({
  agentId: z.string(),
  turnId: z.number(),
  phase: z.enum(['start', 'end']).optional(),
  entries: z.record(z.string(), backupEntrySchema),
});

export class FileHistoryCheckpointed extends AgentEvent2<
  z.infer<typeof fileHistoryCheckpointedSchema>
> {
  static override readonly type = 'file_history.checkpoint';
  static override readonly durable = true;
  static override readonly schema = fileHistoryCheckpointedSchema;
}
export interface FileHistoryCheckpointed {
  readonly agentId: string;
  readonly turnId: number;
  readonly phase?: FileHistoryCheckpointPhase;
  readonly entries: Readonly<Record<string, FileBackupEntry>>;
}

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
  ].sort((a, b) => b - a);
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

export const fileHistoryKey = defineState(
  'fileHistory',
  (): FileHistoryState => ({ checkpoints: [], tracked: [] }),
)
  .replayable({ schema: z.custom<FileHistoryState>() })
  .on(FileHistoryCheckpointed, (s, e) => {
    const phase = checkpointPhaseOf(e);
    const existing = s.checkpoints.find(
      (c) => c.turnId === e.turnId && checkpointPhaseOf(c) === phase,
    );
    if (existing !== undefined) {
      existing.entries = cloneEntries(e.entries);
      return;
    }
    s.checkpoints.push({ turnId: e.turnId, phase, entries: cloneEntries(e.entries) });
    const displaced = new Set(displacedCheckpoints(s.checkpoints));
    if (displaced.size > 0) {
      s.checkpoints = s.checkpoints.filter((c) => !displaced.has(c));
      const kept = new Set<string>();
      for (const checkpoint of s.checkpoints) {
        for (const path of Object.keys(checkpoint.entries)) kept.add(path);
      }
      s.tracked = s.tracked.filter((path) => kept.has(path));
    }
  })
  .on(FileHistoryTracked, (s, e) => {
    if (!s.tracked.includes(e.path)) s.tracked.push(e.path);
    let checkpoint = s.checkpoints.find(
      (c) => c.turnId === e.turnId && checkpointPhaseOf(c) === 'start',
    );
    if (checkpoint === undefined) {
      s.checkpoints.push({ turnId: e.turnId, phase: 'start', entries: {} });
      checkpoint = s.checkpoints.at(-1);
    }
    if (checkpoint !== undefined && !Object.hasOwn(checkpoint.entries, e.path)) {
      checkpoint.entries[e.path] = { ...e.entry };
    }
  });
