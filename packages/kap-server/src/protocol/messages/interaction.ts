import { z } from 'zod';

import { isoDateTimeSchema, timelineMessageBase } from './base';

export const interactionApprovalRequestSchema = z.object({
  tool_name: z.string().min(1),
  action: z.string(),
  tool_input_display: z.unknown().optional(),
  expires_at: isoDateTimeSchema.optional(),
});

export type InteractionApprovalRequest = z.infer<typeof interactionApprovalRequestSchema>;

export const interactionApprovalResponseSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  scope: z.literal('session').optional(),
  feedback: z.string().optional(),
  selected_label: z.string().optional(),
});

export type InteractionApprovalResponse = z.infer<typeof interactionApprovalResponseSchema>;

export const interactionQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string().optional(),
});

export type InteractionQuestionOption = z.infer<typeof interactionQuestionOptionSchema>;

export const interactionQuestionItemSchema = z.object({
  id: z.string().min(1),
  question: z.string(),
  header: z.string().optional(),
  body: z.string().optional(),
  options: z.array(interactionQuestionOptionSchema),
  multi_select: z.boolean().optional(),
  allow_other: z.boolean().optional(),
  other_label: z.string().optional(),
  other_description: z.string().optional(),
});

export type InteractionQuestionItem = z.infer<typeof interactionQuestionItemSchema>;

export const interactionQuestionRequestSchema = z.object({
  questions: z.array(interactionQuestionItemSchema),
});

export type InteractionQuestionRequest = z.infer<typeof interactionQuestionRequestSchema>;

export const interactionQuestionAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), option_id: z.string().min(1) }),
  z.object({ kind: z.literal('multi'), option_ids: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('other'), text: z.string() }),
  z.object({
    kind: z.literal('multi_with_other'),
    option_ids: z.array(z.string().min(1)),
    other_text: z.string(),
  }),
  z.object({ kind: z.literal('skipped') }),
]);

export type InteractionQuestionAnswer = z.infer<typeof interactionQuestionAnswerSchema>;

export const interactionQuestionResponseSchema = z.object({
  answers: z.record(z.string().min(1), interactionQuestionAnswerSchema),
  method: z.enum(['enter', 'space', 'number_key', 'click']).optional(),
  note: z.string().optional(),
});

export type InteractionQuestionResponse = z.infer<typeof interactionQuestionResponseSchema>;

export const interactionStateSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'answered',
  'dismissed',
]);

export type InteractionState = z.infer<typeof interactionStateSchema>;

const interactionMessageBase = {
  type: z.literal('interaction'),
  ...timelineMessageBase,
  interaction_id: z.string().min(1),
  state: interactionStateSchema,
  tool_call_id: z.string().min(1).optional(),
};

export const interactionMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    ...interactionMessageBase,
    kind: z.literal('approval'),
    request: interactionApprovalRequestSchema.optional(),
    response: interactionApprovalResponseSchema.optional(),
  }),
  z.object({
    ...interactionMessageBase,
    kind: z.literal('question'),
    request: interactionQuestionRequestSchema.optional(),
    response: interactionQuestionResponseSchema.optional(),
  }),
]);

export type InteractionMessage = z.infer<typeof interactionMessageSchema>;
