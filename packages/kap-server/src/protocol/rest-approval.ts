import { z } from 'zod';

import { approvalRequestSchema } from './approval';

export const listPendingApprovalsQuerySchema = z.object({
  status: z.literal('pending'),
});
export type ListPendingApprovalsQuery = z.infer<typeof listPendingApprovalsQuerySchema>;

export const listPendingApprovalsResponseSchema = z.object({
  items: z.array(approvalRequestSchema),
});
export type ListPendingApprovalsResponse = z.infer<typeof listPendingApprovalsResponseSchema>;
