/**
 *   GET    /v1/models
 *   GET    /v1/providers
 *   GET    /v1/providers/{provider_id}
 *   POST   /v1/providers
 *   PUT    /v1/providers/{provider_id}
 *   DELETE /v1/providers/{provider_id}
 *
 * The catalog item shapes are owned by the engine
 * (`kosong/model/catalog`); these are only the REST list/get wrappers
 * around them, plus the manual create/replace/delete write surface.
 */

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

// The single-provider GET additionally reveals the stored `api_key` so the
// local desktop client can prefill its edit form (the loopback transport is
// already bearer-guarded; the list route and /config stay redacted).
export const getProviderResponseSchema = providerCatalogItemSchema.extend({
  api_key: z.string().optional(),
});
export type GetProviderResponse = z.infer<typeof getProviderResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/providers — manual provider creation
// ---------------------------------------------------------------------------

/**
 * The six wire protocols the core config schema accepts as a provider `type`.
 * (`vertexai` resolves through the google-genai base's vertex mode at runtime.)
 */
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

/**
 * Shared superRefine checks for the create/replace bodies: the base URL must
 * be trimmed and must not contain an env placeholder the config cannot
 * express (mirrors resolveCatalogImport), and models must not repeat a model
 * id (the alias build would silently keep only the last one).
 */
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

/** The provider id shape accepted by the create/replace routes. */
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

// ---------------------------------------------------------------------------
// PUT /v1/providers/{provider_id} — replace-style provider edit
// ---------------------------------------------------------------------------

/**
 * The desktop "edit & save" payload: the whole provider form. `new_id`
 * renames the provider (the id in the path is the current identity) — the
 * providers key, all model aliases, default_provider and a default_model
 * pointing at an old alias are migrated to the new id. `api_key` is
 * tri-state so the edit form can leave the stored key untouched — absent
 * keeps it, `""` clears it, anything else replaces it.
 */
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

// ---------------------------------------------------------------------------
// GET /v1/catalog/providers[{catalog_id}] — models.dev directory (proxied)
// ---------------------------------------------------------------------------

/** Pruned catalog model shape — enough for the import preview, nothing more. */
export const catalogModelItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  max_context_size: z.number().int().min(1),
  capabilities: z.array(z.string()).optional(),
  reasoning: z.boolean(),
});
export type CatalogModelItem = z.infer<typeof catalogModelItemSchema>;

/**
 * One browsable models.dev entry. `rejected: true` means this client version
 * cannot import it at all (greyed out, `reject_reason` explains);
 * `needs_base_url: true` means the import form must collect a base URL.
 */
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

/**
 * Body of the `/providers:action` collection route. Every field is optional
 * so the bodyless `:refresh` actions (and their legacy `{}` bodies) still
 * validate; the `:import_catalog` handler enforces `catalog_id` and the
 * `:import_registry` handler enforces `url` themselves.
 *
 * `:import_catalog` semantics: import a models.dev entry as a configured
 * provider; `id` overrides the catalog id as the local provider id, and
 * importing an id that already exists is a refresh (the provider and its
 * aliases are rewritten from the catalog — the same re-import semantics as
 * the TUI). The global default_provider/default_model pointers are never
 * modified.
 */
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

// ---------------------------------------------------------------------------
// POST /v1/providers:import_registry — import a custom registry (api.json)
// ---------------------------------------------------------------------------

/**
 * Import a models.dev-shaped private registry (api.json URL + optional Bearer
 * key) as configured providers. Re-import semantics: providers previously
 * imported from the same URL but no longer listed are removed (the URL is the
 * stable registry identity; the key commonly rotates). The global
 * default_provider/default_model pointers are never modified.
 */
export const importCustomRegistryResponseSchema = z.object({
  providers: z.array(providerCatalogItemSchema),
  models_imported: z.number().int().min(0),
});
export type ImportCustomRegistryResponse = z.infer<typeof importCustomRegistryResponseSchema>;
