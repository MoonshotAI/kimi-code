/**
 * `auth` domain — the v1 OAuth wire DTO schemas.
 *
 * Request/response shapes of the v1 `/oauth/*` endpoints plus the managed
 * OAuth provider model-refresh response, defined as zod schemas so the
 * transports validate against the same contract the `IOAuthService` returns.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from '#/_base/utils/isoDateTime';

export const oauthFlowStatusEnum = z.enum([
  'pending',
  'authenticated',
  'denied',
  'expired',
  'cancelled',
]);
export type OAuthFlowStatus = z.infer<typeof oauthFlowStatusEnum>;

/**
 * Result of `POST /v1/oauth/login`.
 *
 * Two shapes, discriminated by `status`:
 *   - `pending`: a real device-code flow was started; the `verification_*`,
 *     `user_code`, `expires_*`, and `interval` fields are populated so the
 *     client can render the device-code step and start polling.
 *   - `authenticated`: the toolkit already had a usable token and short-
 *     circuited via its `ensureFresh` fast path, so no device code was
 *     issued. The client can skip the device-code step and treat the login
 *     as already complete.
 */
export const oauthFlowStartPendingSchema = z.object({
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
export type OAuthFlowStartPending = z.infer<typeof oauthFlowStartPendingSchema>;

export const oauthFlowStartAuthenticatedSchema = z.object({
  flow_id: z.string().min(1),
  provider: z.string().min(1),
  status: z.literal('authenticated'),
});
export type OAuthFlowStartAuthenticated = z.infer<typeof oauthFlowStartAuthenticatedSchema>;

export const oauthFlowStartSchema = z.discriminatedUnion('status', [
  oauthFlowStartPendingSchema,
  oauthFlowStartAuthenticatedSchema,
]);
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

export const oauthLoginCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  status: oauthFlowStatusEnum,
});
export type OAuthLoginCancelResponse = z.infer<typeof oauthLoginCancelResponseSchema>;

export const oauthLogoutResponseSchema = z.object({
  logged_out: z.literal(true),
  provider: z.string().min(1),
});
export type OAuthLogoutResponse = z.infer<typeof oauthLogoutResponseSchema>;

const providerRefreshChangeSchema = z.object({
  provider_id: z.string().min(1),
  provider_name: z.string().min(1),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
});

const providerRefreshFailureSchema = z.object({
  provider: z.string().min(1),
  reason: z.string().min(1),
});

// Same response shape as the modelCatalog refresh endpoint; defined
// self-contained here because the two domains sit at different layers and the
// `auth` domain owns the OAuth-provider refresh operation.
export const refreshOAuthProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
});
export type RefreshOAuthProviderModelsResponse = z.infer<
  typeof refreshOAuthProviderModelsResponseSchema
>;

// ---------------------------------------------------------------------------
// Managed-account usage (`GET /v1/oauth/usage`) — mirrors the toolkit's
// `AuthManagedUsageResult` (camelCase domain model → snake_case wire DTO).
// ---------------------------------------------------------------------------

export const usageRowSchema = z.object({
  label: z.string(),
  used: z.number().int(),
  limit: z.number().int(),
  reset_hint: z.string().optional(),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

export const boosterWalletSchema = z.object({
  balance_cents: z.number().int(),
  total_cents: z.number().int(),
  monthly_charge_limit_enabled: z.boolean(),
  monthly_charge_limit_cents: z.number().int(),
  monthly_used_cents: z.number().int(),
  currency: z.string(),
});
export type BoosterWallet = z.infer<typeof boosterWalletSchema>;

export const managedUsageOkSchema = z.object({
  kind: z.literal('ok'),
  summary: usageRowSchema.nullable(),
  limits: z.array(usageRowSchema),
  extra_usage: boosterWalletSchema.nullable(),
});
export type ManagedUsageOk = z.infer<typeof managedUsageOkSchema>;

export const managedUsageErrorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
  status: z.number().int().optional(),
});
export type ManagedUsageError = z.infer<typeof managedUsageErrorSchema>;

export const managedUsageResultSchema = z.discriminatedUnion('kind', [
  managedUsageOkSchema,
  managedUsageErrorSchema,
]);
export type ManagedUsageResult = z.infer<typeof managedUsageResultSchema>;
