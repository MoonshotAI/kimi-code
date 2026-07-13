/**
 * `wireRecord` domain (L6) — wire-log metadata envelope op.
 *
 * Declares a marker-only wire Model and the `metadata` Op whose flattened
 * record carries the wire-protocol envelope (`protocol_version`, `created_at`)
 * as the first record of each agent `wire.jsonl`. It is the only persisted
 * record that opts out of the `time` stamp, matching v1. Defined through the
 * low-level `wire` registry so `WireService` can persist the envelope through
 * the same append path as every other Op. Scope-agnostic.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

const MetadataModel = defineModel<null>('wire.metadata', () => null);

declare module '#/wire/types' {
  interface PersistedOpMap {
    metadata: typeof wireMetadata;
  }
}

export const wireMetadata = MetadataModel.defineOp('metadata', {
  schema: z.object({ protocol_version: z.string(), created_at: z.number() }),
  stamp: false,
  apply: (s) => s,
});
