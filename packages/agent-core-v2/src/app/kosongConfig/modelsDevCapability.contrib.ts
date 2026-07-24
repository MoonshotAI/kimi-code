/**
 * `app/kosongConfig` domain (L3) — contributes the bundled models.dev
 * snapshot as a capability source without making the L2 provider domain
 * depend on app configuration. The multi-megabyte snapshot is parsed lazily
 * on the first lookup and never refreshed from the network.
 */

import { registerModelCapabilityResolver } from '#/kosong/provider/modelCapabilityResolver';

import { BUILT_IN_MODELS_DEV_JSON } from './builtInModelsDev';
import {
  getModelsDevModelCapability,
  type ModelsDevCatalog,
} from './modelsDev';
import { loadBuiltInModelsDevCatalog } from './modelsDevUpstream';

let catalog: ModelsDevCatalog | undefined | null = null;

registerModelCapabilityResolver(({ protocol, providerType, modelName }) => {
  if (catalog === null) {
    catalog = loadBuiltInModelsDevCatalog(BUILT_IN_MODELS_DEV_JSON);
  }
  const wire = providerType === 'vertexai' ? providerType : protocol;
  const match = getModelsDevModelCapability(catalog, wire, modelName);
  if (match === undefined) return undefined;
  return {
    capability: match.capability,
    source: {
      kind: 'builtin',
      detail: `models.dev built-in snapshot provider '${match.providerId}'`,
    },
  };
});
