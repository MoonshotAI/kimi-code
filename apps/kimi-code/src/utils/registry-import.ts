/**
 * Persists a custom-registry (api.json) import onto the harness as two atomic
 * `replaceConfigSections` writes, shared by the CLI `kimi provider add` flow
 * and the TUI registry dialog. The first write persists the removal phase —
 * required because the models/providers writeback merges fields from the raw
 * TOML, so rebuilt records only come out fresh if the old ones were purged
 * from disk first. The second writes the rebuilt records and the restored (or
 * cleared) default pointers and thinking state.
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
  const config = await harness.getConfig();
  const removal = removeCustomRegistryEntries(asManaged(config), entries, source);
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
    thinking: config.thinking,
  });
}

function asManaged(config: unknown): ManagedKimiConfigShape {
  return config as ManagedKimiConfigShape;
}
