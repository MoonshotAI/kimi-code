/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';

export interface AutoReviewStartedPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
}

export class AutoReviewStarted extends AgentEvent2<AutoReviewStartedPayload> {
  static override readonly type = 'auto_review.started';
  static override readonly observable = true;
}
export interface AutoReviewStarted extends AutoReviewStartedPayload {}

export interface AutoReviewStartedEvent extends Omit<AutoReviewStartedPayload, 'agentId'> {
  readonly type: 'auto_review.started';
}

const autoReviewCompletedSchema = z.object({
  agentId: z.string(),
  turnId: z.number().int().nonnegative(),
  toolCallId: z.string(),
  toolName: z.string(),
  triggerPolicy: z.string(),
  model: z.string(),
  decision: z.enum(['allow', 'deny', 'failed']),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  reason: z.string().optional(),
  durationMs: z.number().nonnegative(),
});

export class AutoReviewCompleted extends AgentEvent2<z.infer<typeof autoReviewCompletedSchema>> {
  static override readonly type = 'auto_review.decision';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = autoReviewCompletedSchema;
}
export interface AutoReviewCompleted {
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly triggerPolicy: string;
  readonly model: string;
  readonly decision: 'allow' | 'deny' | 'failed';
  readonly risk?: 'low' | 'medium' | 'high';
  readonly reason?: string;
  readonly durationMs: number;
}

export interface AutoReviewCompletedEvent extends Omit<z.infer<typeof autoReviewCompletedSchema>, 'agentId'> {
  readonly type: 'auto_review.decision';
}

registerEvent2Class(AutoReviewStarted);
registerEvent2Class(AutoReviewCompleted);
