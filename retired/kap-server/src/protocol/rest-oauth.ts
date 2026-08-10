/**
 *   POST   /v1/oauth/login
 *   GET    /v1/oauth/login
 *   POST   /v1/oauth/logout
 *
 * Request-side query/body schemas for the OAuth routes, plus the response
 * shapes — localized (stage 4: protocol localisation) from the v2
 * `app/auth/oauthProtocol` so kap-server no longer imports it.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './session';

export const oauthLoginStartRequestSchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLoginStartRequest = z.infer<typeof oauthLoginStartRequestSchema>;

export const oauthLoginQuerySchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLoginQuery = z.infer<typeof oauthLoginQuerySchema>;

export const oauthLogoutRequestSchema = z.object({
  provider: z.string().min(1).optional(),
});
export type OAuthLogoutRequest = z.infer<typeof oauthLogoutRequestSchema>;

// ---------------------------------------------------------------------------
// Response schemas — copied from `agent-core-v2/app/auth/oauthProtocol`
// (v2 engine retirement).
// ---------------------------------------------------------------------------

const oauthFlowStatusEnum = z.enum([
  'pending',
  'authenticated',
  'denied',
  'expired',
  'cancelled',
]);

const oauthFlowStartPendingSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  status: z.literal('pending'),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  user_code: z.string().min(1),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
  expires_at: isoDateTimeSchema,
});

const oauthFlowStartAuthenticatedSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  status: z.literal('authenticated'),
});

export const oauthFlowStartSchema = z.discriminatedUnion('status', [
  oauthFlowStartPendingSchema,
  oauthFlowStartAuthenticatedSchema,
]);

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

export const oauthLoginCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  status: oauthFlowStatusEnum,
});

export const oauthLogoutResponseSchema = z.object({
  logged_out: z.literal(true),
  provider: z.string().min(1),
});

const usageRowSchema = z.object({
  label: z.string(),
  used: z.number().int(),
  limit: z.number().int(),
  reset_hint: z.string().optional(),
});

const boosterWalletSchema = z.object({
  balance_cents: z.number().int(),
  total_cents: z.number().int(),
  monthly_charge_limit_enabled: z.boolean(),
  monthly_charge_limit_cents: z.number().int(),
  monthly_used_cents: z.number().int(),
  currency: z.string(),
});

const managedUsageOkSchema = z.object({
  kind: z.literal('ok'),
  summary: usageRowSchema.nullable(),
  limits: z.array(usageRowSchema),
  extra_usage: boosterWalletSchema.nullable(),
});

const managedUsageErrorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
  status: z.number().int().optional(),
});

export const managedUsageResultSchema = z.discriminatedUnion('kind', [
  managedUsageOkSchema,
  managedUsageErrorSchema,
]);
