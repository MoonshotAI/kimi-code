import { z } from 'zod';

import { PROVIDER_ID_PATTERN } from '@moonshot-ai/agent-core-v2';
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

export const getProviderResponseSchema = providerCatalogItemSchema.extend({
  api_key: z.string().optional(),
});
export type GetProviderResponse = z.infer<typeof getProviderResponseSchema>;

export const providerWireTypeSchema = z.enum([
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
]);
export type ProviderWireType = z.infer<typeof providerWireTypeSchema>;

export const createProviderModelSchema = z.object({
  model: z.string().min(1),
  max_context_size: z.number().int().min(1),
  display_name: z.string().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  max_output_size: z.number().int().min(1).optional(),
  support_efforts: z.array(z.string().min(1)).optional(),
  adaptive_thinking: z.boolean().optional(),
});
export type CreateProviderModel = z.infer<typeof createProviderModelSchema>;

function refineProviderForm(
  value: { base_url?: string | undefined; models: Array<{ model: string }> },
  ctx: z.RefinementCtx,
): void {
  if (value.base_url !== undefined && value.base_url.includes('${')) {
    ctx.addIssue({
      code: 'custom',
      message: 'base_url must not contain an environment variable placeholder',
      path: ['base_url'],
    });
  }
  const seen = new Set<string>();
  for (const entry of value.models) {
    if (seen.has(entry.model)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate model: ${entry.model}`,
        path: ['models'],
      });
      return;
    }
    seen.add(entry.model);
  }
}

export const providerIdSchema = z
  .string()
  .regex(
    PROVIDER_ID_PATTERN,
    'id must start with a letter or digit and may only contain letters, digits, "-", "_" and spaces',
  );

export const createProviderRequestSchema = z
  .object({
    id: providerIdSchema,
    type: providerWireTypeSchema,
    api_key: z.string().optional(),
    base_url: z.string().trim().optional(),
    default_model: z.string().min(1).optional(),
    models: z.array(createProviderModelSchema).min(1),
  })
  .superRefine((value, ctx) => {
    refineProviderForm(value, ctx);
    if (
      value.default_model !== undefined &&
      !value.models.some((entry) => entry.model === value.default_model)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'default_model must be one of models[].model',
        path: ['default_model'],
      });
    }
  });
export type CreateProviderRequest = z.infer<typeof createProviderRequestSchema>;

export const createProviderResponseSchema = providerCatalogItemSchema;
export type CreateProviderResponse = z.infer<typeof createProviderResponseSchema>;

export const replaceProviderRequestSchema = z
  .object({
    new_id: providerIdSchema.optional(),
    type: providerWireTypeSchema,
    api_key: z.string().optional(),
    base_url: z.string().trim().optional(),
    default_model: z.string().min(1).optional(),
    models: z.array(createProviderModelSchema).min(1),
  })
  .superRefine((value, ctx) => {
    refineProviderForm(value, ctx);
    if (
      value.default_model !== undefined &&
      !value.models.some((entry) => entry.model === value.default_model)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'default_model must be one of models[].model',
        path: ['default_model'],
      });
    }
  });
export type ReplaceProviderRequest = z.infer<typeof replaceProviderRequestSchema>;

export const replaceProviderResponseSchema = z.object({
  provider: providerCatalogItemSchema,
});
export type ReplaceProviderResponse = z.infer<typeof replaceProviderResponseSchema>;

export const catalogModelItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  max_context_size: z.number().int().min(1),
  capabilities: z.array(z.string()).optional(),
  reasoning: z.boolean(),
});
export type CatalogModelItem = z.infer<typeof catalogModelItemSchema>;

export const catalogProviderItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  wire_type: providerWireTypeSchema.nullable(),
  guessed: z.boolean(),
  needs_base_url: z.boolean(),
  rejected: z.boolean(),
  reject_reason: z.string().nullable(),
  env_key: z.string().nullable(),
  models: z.array(catalogModelItemSchema),
});
export type CatalogProviderItem = z.infer<typeof catalogProviderItemSchema>;

export const listCatalogProvidersResponseSchema = z.object({
  items: z.array(catalogProviderItemSchema),
});
export type ListCatalogProvidersResponse = z.infer<typeof listCatalogProvidersResponseSchema>;

export const getCatalogProviderResponseSchema = catalogProviderItemSchema;
export type GetCatalogProviderResponse = z.infer<typeof getCatalogProviderResponseSchema>;

export const providerCollectionActionBodySchema = z.object({
  catalog_id: z.string().min(1).optional(),
  api_key: z.string().optional(),
  base_url: z.string().optional(),
  id: providerIdSchema.optional(),
  url: z.string().min(1).optional(),
});
export type ProviderCollectionActionBody = z.infer<typeof providerCollectionActionBodySchema>;

export const importCatalogProviderResponseSchema = z.object({
  provider: providerCatalogItemSchema,
  models_imported: z.number().int().min(0),
});
export type ImportCatalogProviderResponse = z.infer<typeof importCatalogProviderResponseSchema>;

export const importCustomRegistryResponseSchema = z.object({
  providers: z.array(providerCatalogItemSchema),
  models_imported: z.number().int().min(0),
});
export type ImportCustomRegistryResponse = z.infer<typeof importCustomRegistryResponseSchema>;
