import { z } from 'zod';

export const modelCatalogItemSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  display_name: z.string().min(1).optional(),
  max_context_size: z.number().int().min(1),
  capabilities: z.array(z.string()).optional(),
});
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

export const providerCatalogStatusSchema = z.enum([
  'connected',
  'error',
  'unconfigured',
]);
export type ProviderCatalogStatus = z.infer<typeof providerCatalogStatusSchema>;

export const providerCatalogItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  base_url: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string().min(1)).optional(),
});
export type ProviderCatalogItem = z.infer<typeof providerCatalogItemSchema>;

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
