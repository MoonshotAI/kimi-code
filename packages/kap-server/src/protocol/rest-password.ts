/**
 *   GET  /v1/sessions/{session_id}/passwords
 *   POST /v1/sessions/{session_id}/passwords/{password_id}
 *
 * SECURITY: the resolve body carries the raw password; it is validated here
 * and handed to the in-process broker, but it must never appear in logs,
 * envelopes, events, or snapshots.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { passwordRequestSchema } from './password';

export const listPendingPasswordsResponseSchema = z.object({
  items: z.array(passwordRequestSchema),
});
export type ListPendingPasswordsResponse = z.infer<typeof listPendingPasswordsResponseSchema>;

export const passwordResolveRequestSchema = z.union([
  z.object({ password: z.string() }),
  z.object({ cancelled: z.literal(true) }),
]);
export type PasswordResolveRequest = z.infer<typeof passwordResolveRequestSchema>;

export const passwordResolveResultSchema = z.object({
  resolved: z.literal(true),
  resolved_at: isoDateTimeSchema,
});
export type PasswordResolveResult = z.infer<typeof passwordResolveResultSchema>;

export const passwordAlreadyResolvedDataSchema = z.object({
  resolved: z.literal(false),
});
export type PasswordAlreadyResolvedData = z.infer<typeof passwordAlreadyResolvedDataSchema>;
