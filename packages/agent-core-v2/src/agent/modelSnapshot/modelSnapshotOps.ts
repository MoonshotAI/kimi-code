/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { type AssertExact, type Equal } from '#/_base/utils/typeEquality';
import { ModelOverrideSchema, OAuthRefSchema } from '#/app/kosongConfig/configSection';
import { Event2 } from '#/app/event/event2';
import { ProtocolSchema } from '#/kosong/protocol/protocol';
import { defineState } from '#/state/state';

import type { ModelSnapshotRecord } from './modelSnapshot';

export const modelSnapshotRecordSchema = z.object({
  providerId: z.string().optional(),
  baseUrl: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  protocol: ProtocolSchema.optional(),
  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  maxContextSize: z.number().optional(),
  maxInputSize: z.number().optional(),
  maxOutputSize: z.number().optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  betaApi: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
  overrides: ModelOverrideSchema.optional(),
});

type _AssertModelSnapshotRecord = AssertExact<
  Equal<z.infer<typeof modelSnapshotRecordSchema>, ModelSnapshotRecord>
>;

const modelSnapshotSchema = z.object({
  alias: z.string().min(1),
  record: modelSnapshotRecordSchema,
});

export class ModelSnapshot extends Event2<z.infer<typeof modelSnapshotSchema>> {
  static override readonly type = 'model.snapshot';
  static override readonly durable = true;
  static override readonly schema = modelSnapshotSchema;
}
export interface ModelSnapshot extends z.infer<typeof modelSnapshotSchema> {}

export type ModelSnapshotsState = Record<string, ModelSnapshotRecord>;

export const modelSnapshotsKey = defineState(
  'modelSnapshot.records',
  (): ModelSnapshotsState => ({}),
)
  .replayable({ schema: z.record(z.string(), modelSnapshotRecordSchema) })
  .on(ModelSnapshot, (s, e) => {
    s[e.alias] = e.record;
  });
