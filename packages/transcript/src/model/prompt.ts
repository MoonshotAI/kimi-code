/**
 * Prompt queue entities of one agent.
 *
 * The engine's prompt queue (the running prompt plus queued/blocked pending
 * ones) lives beside the timeline: prompts are global entities like tasks,
 * addressed by `promptId` and never paginated. `content` is the opaque
 * message content parts array — this layer never interprets it.
 */

import type { PromptId } from './ids';

export type TranscriptPromptStatus =
  | 'running'
  | 'queued'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface TranscriptPrompt {
  readonly promptId: PromptId;
  readonly status: TranscriptPromptStatus;
  /** The user message this prompt materialized as, when it did. */
  readonly userMessageId?: string;
  /** Open content envelope (the engine's message content parts). */
  readonly content?: unknown;
  readonly createdAt: string;
  readonly finishedAt?: string;
  /** Set when the prompt was rerouted by a steer. */
  readonly steeredAt?: string;
}
