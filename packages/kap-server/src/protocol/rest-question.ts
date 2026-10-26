import { z } from 'zod';

import { questionRequestSchema } from './question';

export const listPendingQuestionsQuerySchema = z.object({
  status: z.literal('pending'),
});
export type ListPendingQuestionsQuery = z.infer<typeof listPendingQuestionsQuerySchema>;

export const listPendingQuestionsResponseSchema = z.object({
  items: z.array(questionRequestSchema),
});
export type ListPendingQuestionsResponse = z.infer<typeof listPendingQuestionsResponseSchema>;
