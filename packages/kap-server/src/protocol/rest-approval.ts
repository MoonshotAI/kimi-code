/**
 *   GET  /v1/sessions/{session_id}/approvals?status=pending
 *   POST /v1/sessions/{session_id}/approvals/{approval_id}
 */

import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { approvalRequestSchema, approvalResponseSchema } from './approval';

export const listPendingApprovalsQuerySchema = z.object({
  status: z.literal('pending'),
});
export type ListPendingApprovalsQuery = z.infer<typeof listPendingApprovalsQuerySchema>;

export const listPendingApprovalsResponseSchema = z.object({
  items: z.array(approvalRequestSchema),
});
export type ListPendingApprovalsResponse = z.infer<typeof listPendingApprovalsResponseSchema>;

export const approvalResolveRequestSchema = approvalResponseSchema;
export type ApprovalResolveRequest = z.infer<typeof approvalResolveRequestSchema>;

export const approvalResolveResultSchema = z.object({
  resolved: z.literal(true),
  resolved_at: isoDateTimeSchema,
});
export type ApprovalResolveResult = z.infer<typeof approvalResolveResultSchema>;

export const approvalAlreadyResolvedDataSchema = z.object({
  resolved: z.literal(false),
});
export type ApprovalAlreadyResolvedData = z.infer<typeof approvalAlreadyResolvedDataSchema>;
