import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const questionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const questionItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  header: z.string().optional(),
  body: z.string().optional(),
  options: z.array(questionOptionSchema).min(2).max(4),
  multi_select: z.boolean().optional(),
  allow_other: z.boolean().optional(),
  other_label: z.string().optional(),
  other_description: z.string().optional(),
});
export type QuestionItem = z.infer<typeof questionItemSchema>;

export const questionRequestSchema = z.object({
  question_id: z.string().min(1),
  session_id: z.string().min(1),
  turn_id: z.number().int().nonnegative().optional(),
  tool_call_id: z.string().min(1).optional(),
  questions: z.array(questionItemSchema).min(1).max(4),
  created_at: isoDateTimeSchema,
});
export type QuestionRequest = z.infer<typeof questionRequestSchema>;

export const questionAnswerSchema = z.discriminatedUnion('kind', [
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
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

export const questionAnswerMethodSchema = z.enum(['enter', 'space', 'number_key', 'click']);
export type QuestionAnswerMethod = z.infer<typeof questionAnswerMethodSchema>;

export const questionResponseSchema = z.object({
  answers: z.record(z.string().min(1), questionAnswerSchema),
  method: questionAnswerMethodSchema.optional(),
  note: z.string().optional(),
});
export type QuestionResponse = z.infer<typeof questionResponseSchema>;
