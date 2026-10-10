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

export const modelMigrationCandidateSchema = z.object({
  provider_id: z.string().min(1),
  from_alias: z.string().min(1),
  from_model: z.string().min(1),
  to_alias: z.string().min(1),
  to_model: z.string().min(1),
  migration_markdown: z.string(),
  retirement_at: z.string().optional(),
  target_default_effort: z.string().optional(),
});
export type ModelMigrationCandidate = z.infer<typeof modelMigrationCandidateSchema>;

export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
  migrations: z.array(modelMigrationCandidateSchema).optional(),
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

export interface ModelCatalogChangedEvent {
  readonly type: 'event.model_catalog.changed';
  readonly changed: readonly ProviderRefreshChange[];
  readonly unchanged: readonly string[];
  readonly failed: readonly ProviderRefreshFailure[];
  readonly migrations?: readonly ModelMigrationCandidate[];
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
