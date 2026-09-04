import { z } from 'zod';
import { timelineBaseFields } from './base';

export const approvalRequestSchema = z.object({
  tool_name: z.string(),
  input: z.unknown().optional(),
  reason: z.string().optional(),
  display: z.unknown().optional(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const approvalResponseSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  feedback: z.string().optional(),
});
export type ApprovalResponsePayload = z.infer<typeof approvalResponseSchema>;

export const questionItemSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).optional(),
});
export type QuestionItem = z.infer<typeof questionItemSchema>;

export const questionRequestSchema = z.object({
  questions: z.array(questionItemSchema),
});
export type QuestionRequest = z.infer<typeof questionRequestSchema>;

export const questionResponseSchema = z.object({
  answers: z.record(z.string(), z.string()),
});
export type QuestionResponsePayload = z.infer<typeof questionResponseSchema>;

const interactionBase = {
  ...timelineBaseFields,
  interaction_id: z.string(),
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'answered', 'dismissed']),
  tool_call_id: z.string().optional(),
} as const;

export const approvalInteractionMessageSchema = z.object({
  type: z.literal('interaction'),
  ...interactionBase,
  kind: z.literal('approval'),
  request: approvalRequestSchema.optional(),
  response: approvalResponseSchema.optional(),
});
export type ApprovalInteractionMessage = z.infer<typeof approvalInteractionMessageSchema>;

export const questionInteractionMessageSchema = z.object({
  type: z.literal('interaction'),
  ...interactionBase,
  kind: z.literal('question'),
  request: questionRequestSchema.optional(),
  response: questionResponseSchema.optional(),
});
export type QuestionInteractionMessage = z.infer<typeof questionInteractionMessageSchema>;

export const interactionMessageSchema = z.discriminatedUnion('kind', [
  approvalInteractionMessageSchema,
  questionInteractionMessageSchema,
]);
export type InteractionMessage = z.infer<typeof interactionMessageSchema>;
