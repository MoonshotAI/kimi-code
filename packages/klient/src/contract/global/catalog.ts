/**
 * `modelCatalogService` — read-only catalog over configured providers and
 * model aliases, plus the global default-model selection. Mirrors
 * `agent-core-v2/app/modelCatalog/modelCatalog.ts`; wire shapes mirror
 * `protocol/src/modelCatalog.ts` and `protocol/src/rest/modelCatalog.ts`
 * (snake_case fields).
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const modelCatalogItemSchema = z.object({
  provider: z.string(),
  model: z.string(),
  display_name: z.string().optional(),
  max_context_size: z.number(),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
});

export const providerCatalogStatusSchema = z.enum(['connected', 'error', 'unconfigured']);

export const providerCatalogItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  base_url: z.string().optional(),
  default_model: z.string().optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string()).optional(),
});

export const setDefaultModelResponseSchema = z.object({
  default_model: z.string(),
  model: modelCatalogItemSchema,
});

export const refreshProviderModelsOptionsSchema = z.object({
  scope: z.enum(['all', 'oauth']).optional(),
  providerId: z.string().optional(),
});

/** Same shape as `refreshOAuthProviderModelsResponseSchema` in `./auth.js` — keep in sync. */
export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(
    z.object({
      provider_id: z.string(),
      provider_name: z.string(),
      added: z.number(),
      removed: z.number(),
    }),
  ),
  unchanged: z.array(z.string()),
  failed: z.array(z.object({ provider: z.string(), reason: z.string() })),
});

export const catalogContract = {
  listModels: { input: z.tuple([]), output: z.array(modelCatalogItemSchema) },
  listProviders: { input: z.tuple([]), output: z.array(providerCatalogItemSchema) },
  getProvider: { input: z.tuple([z.string()]), output: providerCatalogItemSchema },
  setDefaultModel: { input: z.tuple([z.string()]), output: setDefaultModelResponseSchema },
  refreshProviderModels: {
    input: z.tuple([refreshProviderModelsOptionsSchema.optional()]),
    output: refreshProviderModelsResponseSchema,
  },
} satisfies ServiceContract;
