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

export interface TranscriptResetEvent {
  readonly type: 'transcript.reset';
  readonly agent_id: string;
  readonly snapshot: AgentTranscriptSnapshot;
  readonly has_more_older: boolean;
  readonly seq?: number;
}

export interface TranscriptOpsEvent {
  readonly type: 'transcript.ops';
  readonly agent_id: string;
  readonly ops: readonly TranscriptOperation[];
  readonly seq?: number;
}

export type TranscriptEvent = TranscriptResetEvent | TranscriptOpsEvent;

export const TRANSCRIPT_EVENT_TYPES = ['transcript.reset', 'transcript.ops'] as const;
export type TranscriptEventType = (typeof TRANSCRIPT_EVENT_TYPES)[number];
