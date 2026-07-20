/**
 * Transcript WS event types — owned exclusively by this package (nothing
 * transcript-specific lives in `@moonshot-ai/protocol`).
 *
 * Transcript events ride the v1 WS envelope (`{ type, seq, epoch, volatile,
 * session_id, timestamp, payload }`), and the payloads below are exactly the
 * envelope `payload` shapes: flat events carrying their own `type`
 * discriminant, mirroring how core domain events sit in the envelope.
 *
 * Delivery contract (server-side): every transcript frame is `volatile: true`
 * with the current durable watermark as `seq` — frames are never journaled,
 * never replayed, and never advance the durable seq. Loss surfaces through
 * backpressure → `resync_required` → REST + re-subscribe, which resends
 * `transcript.reset` naturally. Convergence is guaranteed by the L2 rules
 * (every op except `append` is idempotent state; the block/turn flush upserts
 * re-carry whole state).
 */

import { z } from 'zod';

import type { AgentTranscriptSnapshot, TranscriptOperation } from '../ops/operation';
import { transcriptOpsPayloadSchema, transcriptResetPayloadSchema } from './schema';

export const transcriptResetEventSchema = transcriptResetPayloadSchema.extend({
  type: z.literal('transcript.reset'),
});

export const transcriptOpsEventSchema = transcriptOpsPayloadSchema.extend({
  type: z.literal('transcript.ops'),
});

export const transcriptEventSchema = z.discriminatedUnion('type', [
  transcriptResetEventSchema,
  transcriptOpsEventSchema,
]);

/**
 * The TS event shapes live on the domain model (readonly), NOT on zod output
 * (mutable, purely structural) — the schemas above validate wire frames, the
 * types below are what server and client code actually exchange.
 */
export interface TranscriptResetEvent {
  readonly type: 'transcript.reset';
  readonly agent_id: string;
  readonly snapshot: AgentTranscriptSnapshot;
  readonly has_more_older: boolean;
}

export interface TranscriptOpsEvent {
  readonly type: 'transcript.ops';
  readonly agent_id: string;
  readonly ops: readonly TranscriptOperation[];
}

export type TranscriptEvent = TranscriptResetEvent | TranscriptOpsEvent;

export const TRANSCRIPT_EVENT_TYPES = ['transcript.reset', 'transcript.ops'] as const;
export type TranscriptEventType = (typeof TRANSCRIPT_EVENT_TYPES)[number];
