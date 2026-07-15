/**
 * `wireRecord` domain (L6) — wire-log metadata envelope op.
 *
 * Declares a marker-only wire Model and the `metadata` Op whose flattened
 * record carries the wire-protocol envelope (`protocol_version`, `created_at`)
 * as the first record of each agent `wire.jsonl`. It is the only persisted
 * record that opts out of the `time` stamp, matching v1. Defined through the
 * low-level `wire` registry so `WireService` can persist the envelope through
 * the same append path as every other Op. `metadataRecord()` is the single
 * shared factory for the envelope — restore-time healing and fork-time log
 * copies both use it instead of hand-rolling the shape. Scope-agnostic.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
} from '#/agent/wireRecord/migration/migration';
import type { WireRecordMetadata } from './wireRecord';

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

/** A fresh metadata envelope stamped at the current protocol version. */
export function metadataRecord(): WireRecordMetadata {
  return {
    type: 'metadata',
    protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    created_at: Date.now(),
  };
}
