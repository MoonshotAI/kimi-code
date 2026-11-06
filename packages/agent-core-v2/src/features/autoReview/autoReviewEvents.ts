/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';

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
}

registerEvent2Class(AutoReviewCompleted);
