/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';

export interface FileEditSnapshotPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly path: string;
  readonly before?: string | null;
  readonly after?: string;
  readonly truncated?: boolean;
}

export class FileEditSnapshot extends AgentEvent2<FileEditSnapshotPayload> {
  static override readonly type = 'file.edit_snapshot';
  static override readonly observable = true;
}
export interface FileEditSnapshot extends FileEditSnapshotPayload {}

export interface FileBlobRef {
  readonly key: string;
  readonly bytes: number;
}

export interface FileEditSnapshotRecordedPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly path: string;
  readonly before?: FileBlobRef | null;
  readonly after?: FileBlobRef;
  readonly truncated?: boolean;
}

const fileBlobRefSchema = z.object({
  key: z.string(),
  bytes: z.number(),
}) satisfies z.ZodType<FileBlobRef>;

const fileEditSnapshotRecordedSchema = z.object({
  agentId: z.string(),
  turnId: z.number(),
  toolCallId: z.string(),
  path: z.string(),
  before: fileBlobRefSchema.nullable().optional(),
  after: fileBlobRefSchema.optional(),
  truncated: z.boolean().optional(),
}) satisfies z.ZodType<FileEditSnapshotRecordedPayload>;

export class FileEditSnapshotRecorded extends AgentEvent2<FileEditSnapshotRecordedPayload> {
  static override readonly type = 'file.edit_snapshot.recorded';
  static override readonly durable = true;
  static override readonly schema = fileEditSnapshotRecordedSchema;
}
export interface FileEditSnapshotRecorded extends FileEditSnapshotRecordedPayload {}

registerEvent2Class(FileEditSnapshotRecorded);
