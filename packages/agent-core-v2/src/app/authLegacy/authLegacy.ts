import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

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

export interface IAuthLegacyService {
  readonly _serviceBrand: undefined;

  get(): Promise<AuthSummary>;
}

export const IAuthLegacyService: ServiceIdentifier<IAuthLegacyService> =
  createDecorator<IAuthLegacyService>('authLegacyService');
