/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { FileBackupEntry, FileHistoryState } from './fileHistory';

export const FILE_HISTORY_CHECKPOINT_CAP = 200;

const backupEntrySchema = z.object({
  key: z.string().nullable(),
  version: z.number(),
  contentHash: z.string().optional(),
  size: z.number().optional(),
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
  static override readonly observable = true;
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
  entries: z.record(z.string(), backupEntrySchema),
});

export class FileHistoryCheckpointed extends AgentEvent2<
  z.infer<typeof fileHistoryCheckpointedSchema>
> {
  static override readonly type = 'file_history.checkpoint';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = fileHistoryCheckpointedSchema;
}
export interface FileHistoryCheckpointed {
  readonly agentId: string;
  readonly turnId: number;
  readonly entries: Readonly<Record<string, FileBackupEntry>>;
}

export const fileHistoryKey = defineState(
  'fileHistory',
  (): FileHistoryState => ({ checkpoints: [], tracked: [] }),
)
  .replayable({ schema: z.custom<FileHistoryState>() })
  .on(FileHistoryCheckpointed, (s, e) => {
    const existing = s.checkpoints.find((c) => c.turnId === e.turnId);
    if (existing !== undefined) {
      existing.entries = { ...e.entries };
      return;
    }
    s.checkpoints.push({ turnId: e.turnId, entries: { ...e.entries } });
    if (s.checkpoints.length > FILE_HISTORY_CHECKPOINT_CAP) {
      s.checkpoints.splice(0, s.checkpoints.length - FILE_HISTORY_CHECKPOINT_CAP);
    }
  })
  .on(FileHistoryTracked, (s, e) => {
    if (!s.tracked.includes(e.path)) s.tracked.push(e.path);
    let checkpoint = s.checkpoints.find((c) => c.turnId === e.turnId);
    if (checkpoint === undefined) {
      s.checkpoints.push({ turnId: e.turnId, entries: {} });
      checkpoint = s.checkpoints.at(-1);
    }
    if (checkpoint !== undefined && checkpoint.entries[e.path] === undefined) {
      checkpoint.entries[e.path] = { ...e.entry };
    }
  });
