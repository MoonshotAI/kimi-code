/**
 * `GET /auth` wire contract — v1-compatible auth readiness summary
 * (`AuthSummary`), localized from the retired `agent-core-v2/app/authLegacy`
 * adapter. Pure schema: no service calls.
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

export const authSummarySchema = z.object({
  ready: z.boolean(),
  providers_count: z.number().int().nonnegative(),
  default_model: z.string().nullable(),
  managed_provider: managedProviderSummarySchema.nullable(),
});
export type AuthSummary = z.infer<typeof authSummarySchema>;
