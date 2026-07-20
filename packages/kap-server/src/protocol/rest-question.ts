/**
 *   GET    /v1/sessions/{sid}/questions?status=pending
 *   POST   /v1/sessions/{sid}/questions/{qid}             (resolve)
 *   POST   /v1/sessions/{sid}/questions/{qid}:dismiss     (dismiss)
 */

import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { questionRequestSchema, questionResponseSchema } from './question';

export const listPendingQuestionsQuerySchema = z.object({
  status: z.literal('pending'),
});
export type ListPendingQuestionsQuery = z.infer<typeof listPendingQuestionsQuerySchema>;

export const listPendingQuestionsResponseSchema = z.object({
  items: z.array(questionRequestSchema),
});
export type ListPendingQuestionsResponse = z.infer<typeof listPendingQuestionsResponseSchema>;

export const questionResolveRequestSchema = questionResponseSchema;
export type QuestionResolveRequest = z.infer<typeof questionResolveRequestSchema>;

export const questionResolveResultSchema = z.object({
  resolved: z.literal(true),
  resolved_at: isoDateTimeSchema,
});
export type QuestionResolveResult = z.infer<typeof questionResolveResultSchema>;

export const questionAlreadyResolvedDataSchema = z.object({
  resolved: z.literal(false),
});
export type QuestionAlreadyResolvedData = z.infer<typeof questionAlreadyResolvedDataSchema>;

export const questionDismissResultSchema = z.object({
  dismissed: z.literal(true),
  dismissed_at: isoDateTimeSchema,
});
export type QuestionDismissResult = z.infer<typeof questionDismissResultSchema>;
