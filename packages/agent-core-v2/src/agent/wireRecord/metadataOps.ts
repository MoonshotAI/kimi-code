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

import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';

const MetadataModel = defineModel<null>('wire.metadata', () => null);

export interface WireMetadataPayload {
  readonly protocol_version: string;
  readonly created_at: number;
}

export const wireMetadata = defineOp(MetadataModel, 'metadata', {
  stamp: false,
  apply: (s, _p: WireMetadataPayload): null => s,
});
