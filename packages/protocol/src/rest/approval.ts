/**
 *   GET  /v1/sessions/{session_id}/approvals?status=pending
 *     Reply: { items: ApprovalRequest[] }
 *
 *   POST /v1/sessions/{session_id}/approvals/{approval_id}
 *     Body:  ApprovalResponse (decision + optional scope/feedback/selected_label)
 *     Reply: ApprovalResolveResult { resolved: true, resolved_at }
 *
 * **Error codes** (REST.md §3.6):
 *   - 40001 (validation.failed)
 *   - 40404 (approval.not_found)
 *   - 40902 (approval.already_resolved)        — custom envelope w/ data:{resolved:false}
 *   - 41001 (approval.expired)
 */

import { z } from 'zod';

import { approvalRequestSchema, approvalResponseSchema } from '../approval';
import { isoDateTimeSchema } from '../time';

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
