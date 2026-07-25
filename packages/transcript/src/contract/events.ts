/**
 * Transcript WS event types — owned exclusively by this package (nothing
 * transcript-specific lives in `@moonshot-ai/protocol`).
 *
 * Transcript events ride the v1 WS envelope (`{ type, seq, epoch, volatile,
 * session_id, timestamp, payload }`), and the payloads below are exactly the
 * envelope `payload` shapes: flat events carrying their own `type`
 * discriminant, mirroring how core domain events sit in the envelope.
 *
 * Delivery contract (server-side): every transcript event is `volatile: true`
 * with the current durable watermark as the envelope `seq` — events are never
 * journaled into the durable log and never advance its seq. Reliability comes
 * from the transcript layer's own op-batch sequence (the payload `seq` —
 * consecutive per agent, see `transcriptSeqSchema`): sequenced servers keep a
 * bounded per-agent journal, so a client that detects a seq gap (or reconnects)
 * catches up point-to-point via `GET .../transcript/ops?since_seq=` or the
 * `transcript_since` subscription cursor; when the journal no longer covers
 * the gap (`complete: false`) the client falls back to a REST refresh +
 * re-subscribe, which resends `transcript.reset` naturally. Legacy peers omit
 * `seq` entirely and rely on loss signals (`resync_required`, append gaps,
 * reconnect acks) driving full refreshes. Convergence is guaranteed by the L2
 * rules (every op except `append` is idempotent state; the block/turn flush
 * upserts re-carry whole state).
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
 * (mutable, purely structural) — the schemas above validate WS payloads, the
 * types below are what server and client code actually exchange.
 */
export interface TranscriptResetEvent {
  readonly type: 'transcript.reset';
  readonly agent_id: string;
  readonly snapshot: AgentTranscriptSnapshot;
  readonly has_more_older: boolean;
  /** Watermark: the snapshot includes every op batch with seq <= N. */
  readonly seq?: number;
}

export interface TranscriptOpsEvent {
  readonly type: 'transcript.ops';
  readonly agent_id: string;
  readonly ops: readonly TranscriptOperation[];
  /** This batch's sequence number (consecutive per agent). */
  readonly seq?: number;
}

export type TranscriptEvent = TranscriptResetEvent | TranscriptOpsEvent;

export const TRANSCRIPT_EVENT_TYPES = ['transcript.reset', 'transcript.ops'] as const;
export type TranscriptEventType = (typeof TRANSCRIPT_EVENT_TYPES)[number];
