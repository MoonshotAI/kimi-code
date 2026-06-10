/**
 *   POST   /v1/oauth/login   body: { provider? }   data: OAuthFlowStart
 *   GET    /v1/oauth/login   query: { provider? }  data: OAuthFlowStatus | null
 *   DELETE /v1/oauth/login   query: { provider? }  data: { cancelled, status }
 *   POST   /v1/oauth/logout  body: { provider? }   data: { logged_out, provider }
 */
import { z } from 'zod';

import { isoDateTimeSchema } from '../time';

export const oauthFlowStatusEnum = z.enum([
  'pending',
  'authenticated',
  'denied',
  'expired',
  'cancelled',
]);
export type OAuthFlowStatus = z.infer<typeof oauthFlowStatusEnum>;

export const oauthLoginStartRequestSchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLoginStartRequest = z.infer<typeof oauthLoginStartRequestSchema>;

export const oauthFlowStartSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  user_code: z.string().min(1),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
  status: z.literal('pending'),
  expires_at: isoDateTimeSchema,
});
export type OAuthFlowStart = z.infer<typeof oauthFlowStartSchema>;

export const oauthFlowSnapshotSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  status: oauthFlowStatusEnum,
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  user_code: z.string().min(1),
  expires_in: z.number().int().positive(),
  expires_at: isoDateTimeSchema,
  interval: z.number().int().positive(),
  resolved_at: isoDateTimeSchema.optional(),
  error_message: z.string().optional(),
});
export type OAuthFlowSnapshot = z.infer<typeof oauthFlowSnapshotSchema>;

export const oauthLoginQuerySchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLoginQuery = z.infer<typeof oauthLoginQuerySchema>;

export const oauthLoginCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  status: oauthFlowStatusEnum,
});
export type OAuthLoginCancelResponse = z.infer<typeof oauthLoginCancelResponseSchema>;

export const oauthLogoutRequestSchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLogoutRequest = z.infer<typeof oauthLogoutRequestSchema>;

export const oauthLogoutResponseSchema = z.object({
  logged_out: z.literal(true),
  provider: z.string().min(1),
});
export type OAuthLogoutResponse = z.infer<typeof oauthLogoutResponseSchema>;
