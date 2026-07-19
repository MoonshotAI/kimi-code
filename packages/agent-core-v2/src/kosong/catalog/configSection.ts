/**
 * `kosong/catalog` domain (L3) — `modelCatalog` config-section schema.
 *
 * Owns the `[model_catalog]` configuration section (provider-model catalog
 * auto-refresh cadence). Self-registered at module load via
 * `registerConfigSection`, mirroring the per-domain `configSection.ts`
 * convention, so the `config` domain never imports this domain's types.
 *
 * Read by the kap-server model-catalog refresh scheduler to decide the
 * refresh interval and whether to refresh once on start. Env vars
 * (`KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS`,
 * `KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START`) override these values at the
 * scheduler edge.
 *
 * Side-effect module: production code must NOT import this yet (the legacy
 * `app/modelCatalog/configSection` still owns the section in production);
 * tests import it on demand.
 */

import { z } from 'zod';

import { registerConfigSection } from '../../app/config/configSectionContributions';

export const MODEL_CATALOG_SECTION = 'modelCatalog';

export const ModelCatalogConfigSchema = z.object({
  refreshIntervalMs: z.number().int().min(0).optional(),
  refreshOnStart: z.boolean().optional(),
});

export type ModelCatalogConfig = z.infer<typeof ModelCatalogConfigSchema>;

registerConfigSection(MODEL_CATALOG_SECTION, ModelCatalogConfigSchema);
