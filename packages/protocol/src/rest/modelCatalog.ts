import { z } from 'zod';

import {
  modelCatalogItemSchema,
  providerCatalogItemSchema,
  providerRefreshChangeSchema,
  providerRefreshFailureSchema,
} from '../modelCatalog';

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

export const setDefaultModelResponseSchema = z.object({
  default_model: z.string().min(1),
  model: modelCatalogItemSchema,
});
export type SetDefaultModelResponse = z.infer<typeof setDefaultModelResponseSchema>;

export const refreshOAuthProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
});
export type RefreshOAuthProviderModelsResponse = z.infer<
  typeof refreshOAuthProviderModelsResponseSchema
>;

export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
});
export type RefreshProviderModelsResponse = z.infer<
  typeof refreshProviderModelsResponseSchema
>;
