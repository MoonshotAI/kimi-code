/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type {
  FileBackupEntry,
  FileHistoryCheckpointPhase,
  FileHistoryState,
} from './fileHistory';

export const FILE_HISTORY_CHECKPOINT_CAP = 400;

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
    const base = s.checkpoints.at(-1)?.entries;
    const merged = cloneEntries(base ?? {});
    for (const [path, entry] of Object.entries(e.entries)) merged[path] = { ...entry };
    const existing = s.checkpoints.find(
      (c) => c.turnId === e.turnId && checkpointPhaseOf(c) === phase,
    );
    if (existing !== undefined) {
      existing.entries = merged;
      return;
    }
    s.checkpoints.push({ turnId: e.turnId, phase, entries: merged });
    if (s.checkpoints.length > FILE_HISTORY_CHECKPOINT_CAP) {
      s.checkpoints.splice(0, s.checkpoints.length - FILE_HISTORY_CHECKPOINT_CAP);
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
