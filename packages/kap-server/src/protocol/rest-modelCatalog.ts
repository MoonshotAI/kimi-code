/**
 *   GET /v1/models
 *   GET /v1/providers
 *   GET /v1/providers/{provider_id}
 *
 * The catalog item shapes are owned by the engine
 * (`kosong/model/catalog`); these are only the REST list/get wrappers
 * around them.
 */

import { z } from 'zod';

import {
  modelCatalogItemSchema,
  providerCatalogItemSchema,
} from '@moonshot-ai/agent-core-v2/kosong/model/catalog';

export const listModelsResponseSchema = z.object({
  items: z.array(modelCatalogItemSchema),
});
export type ListModelsResponse = z.infer<typeof listModelsResponseSchema>;

export const listProvidersResponseSchema = z.object({
  items: z.array(providerCatalogItemSchema),
});
export type ListProvidersResponse = z.infer<typeof listProvidersResponseSchema>;

export const getProviderResponseSchema = providerCatalogItemSchema;
export type GetProviderResponse = z.infer<typeof getProviderResponseSchema>;
