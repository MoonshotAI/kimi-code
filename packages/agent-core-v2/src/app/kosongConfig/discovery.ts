/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
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

export const retiredDefaultSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  from_display_name: z.string().min(1),
});
export type RetiredDefault = z.infer<typeof retiredDefaultSchema>;

export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
  retired_default: retiredDefaultSchema.optional(),
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
  readonly retired_default?: RetiredDefault;
}

export interface RefreshProviderModelsOptions {
  readonly scope?: RefreshProviderModelsScope;
  readonly providerId?: string;
}

export interface RetiredModel {
  readonly from: string;
  readonly to: string;
}

export interface IProviderDiscoveryService {
  readonly _serviceBrand: undefined;

  readonly onDidRetireModel: Event<RetiredModel>;

  refreshProviderModels(
    options?: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse>;

  retiredModelReplacement(alias: string): string | undefined;
}

export const IProviderDiscoveryService: ServiceIdentifier<IProviderDiscoveryService> =
  createDecorator<IProviderDiscoveryService>('providerDiscovery');
