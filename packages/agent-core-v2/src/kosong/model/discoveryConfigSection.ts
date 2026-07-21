/**
 * `kosong/model` domain (L2) — `modelCatalog` config-section schema.
 *
 * Owns the `[modelCatalog]` configuration section (provider-model catalog
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
 * Side-effect module: production gets it from the `src/index.ts`
 * side-effect block; tests import it on demand. This module is the sole
 * owner of the section — the legacy `app/modelCatalog/configSection` is gone.
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
