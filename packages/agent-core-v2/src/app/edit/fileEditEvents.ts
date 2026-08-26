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

const fileEditSnapshotSchema = z.object({
  agentId: z.string(),
  turnId: z.number(),
  toolCallId: z.string(),
  path: z.string(),
  before: z.string().nullable().optional(),
  after: z.string().optional(),
  truncated: z.boolean().optional(),
}) satisfies z.ZodType<FileEditSnapshotPayload>;

export class FileEditSnapshot extends AgentEvent2<FileEditSnapshotPayload> {
  static override readonly type = 'file.edit_snapshot';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = fileEditSnapshotSchema;
}
export interface FileEditSnapshot extends FileEditSnapshotPayload {}

registerEvent2Class(FileEditSnapshot);
