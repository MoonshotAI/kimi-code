/**
 * Turn and step containers.
 *
 * A turn is one agent "run" (a prompt through loop completion). Turn headers
 * are closed structures; steps and frames arrive through their own ops, so a
 * coarse-grained subscriber legitimately holds turns with `steps: []`.
 */

import type { TranscriptFrame } from './frame';
import type { AttachmentId, StepId, TaskId, TurnId } from './ids';

/**
 * What triggered this turn. Drives `inputRenderers` at the view layer. The
 * union is closed; per-origin detail rides in `payload` (open content).
 */
export type TurnOrigin =
  | { kind: 'user'; payload?: unknown }
  | { kind: 'cron'; taskId?: TaskId; payload?: unknown }
  | { kind: 'task'; taskId: TaskId; payload?: unknown }
  | { kind: 'hook'; payload?: unknown }
  | { kind: 'compaction'; payload?: unknown }
  | { kind: 'side'; payload?: unknown }
  | { kind: 'other'; payload?: unknown };

export type TurnState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type StepState = 'running' | 'completed' | 'interrupted' | 'failed';

export interface TranscriptUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly cost?: number;
}

export interface TranscriptTurn {
  readonly kind: 'turn';
  readonly turnId: TurnId;
  /** Per-agent monotonic ordinal; also the pagination cursor anchor. */
  readonly ordinal: number;
  readonly state: TurnState;
  readonly origin: TurnOrigin;
  /** The raw prompt that opened the turn (user text, cron prompt, …). */
  readonly prompt?: string;
  /** Attachments carried by the turn-opening input (entities in `attachments`). */
  readonly attachmentIds?: readonly AttachmentId[];
  readonly steps: TranscriptStep[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly usage?: TranscriptUsage;
}

export interface TranscriptStep {
  readonly kind: 'step';
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly ordinal: number;
  readonly state: StepState;
  readonly frames: TranscriptFrame[];
  readonly startedAt?: string;
  readonly endedAt?: string;
}
