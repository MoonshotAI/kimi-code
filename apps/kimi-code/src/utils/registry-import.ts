/**
 * Persists a custom-registry (api.json) import onto the harness. Shared by the
 * CLI `kimi provider add` flow and the TUI registry dialog so both apply the
 * same removal + rebuild + defaults semantics regardless of harness
 * generation.
 *
 * Two persistence paths, because only one of them can express removals:
 *
 * - v2 harness (`supportsAtomicSectionReplace`): two atomic
 *   `replaceConfigSections` writes. The first persists the removal phase —
 *   required because the models/providers writeback merges fields from the raw
 *   TOML, so rebuilt records only come out fresh if the old ones were purged
 *   from disk first. The second writes the rebuilt records and the restored
 *   (or cleared) default pointers.
 *
 * - v1 harness: `setConfig` deep-merges (retaining omitted keys and skipping
 *   `undefined` defaults), so removals must go through the `removeProvider`
 *   RPC's cascade; the rebuilt records and restored defaults are then written
 *   with one merge — values the restore kept are non-undefined and land, while
 *   pointers the cascade already cleared stay cleared.
 */

import {
  applyCustomRegistryEntries,
  removeCustomRegistryEntries,
  type CustomRegistryProviderEntry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

export async function persistRegistryImport(
  harness: KimiHarness,
  entries: Record<string, CustomRegistryProviderEntry>,
  source: CustomRegistrySource,
): Promise<void> {
  let config = await harness.getConfig();
  const before = new Set(Object.keys(config.providers));
  const removal = removeCustomRegistryEntries(asManaged(config), entries, source);

  if (harness.supportsAtomicSectionReplace()) {
    await harness.replaceConfigSections({
      providers: config.providers,
      models: config.models,
    });
    applyCustomRegistryEntries(asManaged(config), entries, source, removal);
    await harness.replaceConfigSections({
      providers: config.providers,
      models: config.models,
      defaultModel: config.defaultModel,
      defaultProvider: config.defaultProvider,
    });
    return;
  }

  const removedIds = [...before].filter((id) => !(id in config.providers));
  for (const id of removedIds) {
    config = await harness.removeProvider(id);
  }
  applyCustomRegistryEntries(asManaged(config), entries, source, removal);
  await harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
  });
}

function asManaged(config: unknown): ManagedKimiConfigShape {
  return config as ManagedKimiConfigShape;
}
