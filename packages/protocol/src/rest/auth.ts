/**
 * GET /v1/auth
 *   Reply: AuthSummary {
 *     ready,
 *     providers_count,
 *     default_model,
 *     managed_provider,
 *     oauth_providers
 *   }
 */
import { z } from 'zod';

export const managedProviderStatusSchema = z.enum([
  'authenticated',
  'expired',
  'revoked',
  'unauthenticated',
]);
export type ManagedProviderStatus = z.infer<typeof managedProviderStatusSchema>;

export const managedProviderSummarySchema = z.object({
  name: z.string().min(1),
  status: managedProviderStatusSchema,
});
export type ManagedProviderSummary = z.infer<typeof managedProviderSummarySchema>;

export const oauthProviderSummarySchema = managedProviderSummarySchema.extend({
  active: z.boolean(),
  entitlement_status: z.enum(['membership_required']).optional(),
});
export type OAuthProviderSummary = z.infer<typeof oauthProviderSummarySchema>;

export const authSummarySchema = z.object({
  ready: z.boolean(),
  providers_count: z.number().int().nonnegative(),
  default_model: z.string().nullable(),
  managed_provider: managedProviderSummarySchema.nullable(),
  oauth_providers: z.array(oauthProviderSummarySchema).default([]),
});
export type AuthSummary = z.infer<typeof authSummarySchema>;
