/**
 * `kosong/model` domain (L2) — `IProviderDiscoveryService`: remote model
 * discovery and config sync.
 *
 * Refreshes the `[models.*]` / `[providers.*]` configuration from what each
 * provider actually serves (managed OAuth catalogs, open platforms, custom
 * registries) through the shared `@moonshot-ai/kimi-code-oauth` orchestrator,
 * and publishes `event.model_catalog.changed` on change. This is a WRITE
 * path (external world → config), deliberately separate from the read-only
 * `IModelCatalog` materialization/query surface (config → runtime). The
 * OAuth-only managed-provider refresh additionally lives in `auth`
 * (`IOAuthService.refreshOAuthProviderModels`).
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const providerRefreshChangeSchema = z.object({
  provider_id: z.string().min(1),
  provider_name: z.string().min(1),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
});
export type ProviderRefreshChange = z.infer<typeof providerRefreshChangeSchema>;

export const providerRefreshFailureSchema = z.object({
  provider: z.string().min(1),
  reason: z.string().min(1),
});
export type ProviderRefreshFailure = z.infer<typeof providerRefreshFailureSchema>;

export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
});
export type RefreshProviderModelsResponse = z.infer<
  typeof refreshProviderModelsResponseSchema
>;

export type RefreshProviderModelsScope = 'all' | 'oauth';

export interface RefreshProviderModelsOptions {
  readonly scope?: RefreshProviderModelsScope;
  readonly providerId?: string;
}

export interface IProviderDiscoveryService {
  readonly _serviceBrand: undefined;

  refreshProviderModels(
    options?: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse>;
}

export const IProviderDiscoveryService: ServiceIdentifier<IProviderDiscoveryService> =
  createDecorator<IProviderDiscoveryService>('providerDiscovery');
