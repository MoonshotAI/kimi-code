import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { approvalDecisionSchema, approvalResponseSchema, approvalScopeSchema } from './approval';
import { questionAnswerMethodSchema, questionAnswerSchema, questionItemSchema } from './question';

export const interactionOutcomeSchema = z.enum([
  'approved',
  'rejected',
  'cancelled',
  'answered',
  'dismissed',
]);
export type InteractionOutcome = z.infer<typeof interactionOutcomeSchema>;

const interactionEventBaseSchema = z.object({
  type: z.literal('interaction'),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  event_created_at: isoDateTimeSchema,
  interaction_id: z.string().min(1),
  status: z.enum(['pending', 'ended']),
  outcome: interactionOutcomeSchema.optional(),
  ended_at: isoDateTimeSchema.optional(),
  tool_call_id: z.string().min(1).optional(),
});

export const approvalInteractionEventSchema = interactionEventBaseSchema.extend({
  kind: z.literal('approval'),
  request: z.object({
    tool_name: z.string().min(1),
    action: z.string(),
    tool_input_display: z.unknown().optional(),
    expires_at: isoDateTimeSchema,
  }),
  response: approvalResponseSchema.optional(),
});

export const questionInteractionEventSchema = interactionEventBaseSchema.extend({
  kind: z.literal('question'),
  request: z.object({
    questions: z.array(questionItemSchema).min(1).max(4),
  }),
  response: z
    .object({
      answers: z.record(z.string(), z.union([z.string(), z.literal(true)])),
      method: questionAnswerMethodSchema.optional(),
    })
    .optional(),
});

export const interactionEventMessageSchema = z.discriminatedUnion('kind', [
  approvalInteractionEventSchema,
  questionInteractionEventSchema,
]);
export type InteractionEventMessage = z.infer<typeof interactionEventMessageSchema>;

export const interactionRespondParamsSchema = z.object({
  session_id: z.string().min(1),
  interaction_id: z.string().min(1),
});

export const approvalInteractionRespondSchema = z.object({
  kind: z.literal('approval'),
  decision: approvalDecisionSchema,
  scope: approvalScopeSchema.optional(),
  feedback: z.string().optional(),
  selected_label: z.string().optional(),
});

export const questionInteractionRespondSchema = z
  .object({
    kind: z.literal('question'),
    answers: z.record(z.string().min(1), questionAnswerSchema).optional(),
    dismissed: z.literal(true).optional(),
    method: questionAnswerMethodSchema.optional(),
    note: z.string().optional(),
  })
  .refine((body) => (body.dismissed === true) !== (body.answers !== undefined), {
    message: 'provide exactly one of answers or dismissed',
  });

export const interactionRespondRequestSchema = z.discriminatedUnion('kind', [
  approvalInteractionRespondSchema,
  questionInteractionRespondSchema,
]);
export type InteractionRespondRequest = z.infer<typeof interactionRespondRequestSchema>;

export const interactionRespondResultSchema = z.object({
  outcome: interactionOutcomeSchema,
  ended_at: isoDateTimeSchema,
});
export type InteractionRespondResult = z.infer<typeof interactionRespondResultSchema>;
