/**
 * `kosongConfig` domain — `IProviderDiscoveryService`: remote model
 * discovery and config sync.
 *
 * Refreshes the `[models.*]` / `[providers.*]` configuration from what each
 * provider actually serves (managed OAuth catalogs, open platforms, custom
 * registries) through the shared OAuth orchestrator, applies the result to
 * kosong's in-memory registries (the persistence bridge writes it back to
 * config), and publishes `event.model_catalog.changed` on change. This is a
 * WRITE path (external world → kosong → config).
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Event2 } from '#/app/event/event2';

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

export class ModelCatalogChanged extends Event2<{
  readonly payload: RefreshProviderModelsResponse;
}> {
  static override readonly type = 'event.model_catalog.changed';
}
export interface ModelCatalogChanged {
  readonly payload: RefreshProviderModelsResponse;
}

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
