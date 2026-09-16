/**
 * Persists a custom-registry (api.json) import onto the harness as one atomic
 * replacement of every affected config section, shared by the CLI `kimi
 * provider add` flow and the TUI registry dialog.
 */

import {
  applyCustomRegistryEntries,
  customRegistryReplacementKeys,
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
  if (Object.keys(entries).length === 0) {
    throw new Error('Custom registry contained no usable providers.');
  }
  const config = await harness.getConfig();
  const next = structuredClone(config);
  const replacementKeys = customRegistryReplacementKeys(asManaged(config), entries, source);
  applyCustomRegistryEntries(asManaged(next), entries, source);
  const sections: Record<string, unknown> = {
    providers: next.providers,
    models: next.models,
  };
  const expectedValues: Record<string, unknown> = {};
  if (next.defaultModel !== config.defaultModel) {
    sections['defaultModel'] = next.defaultModel;
    expectedValues['defaultModel'] = config.defaultModel;
  }
  if (next.defaultProvider !== config.defaultProvider) {
    sections['defaultProvider'] = next.defaultProvider;
    expectedValues['defaultProvider'] = config.defaultProvider;
  }
  if (JSON.stringify(next.thinking) !== JSON.stringify(config.thinking)) {
    sections['thinking'] = next.thinking;
    expectedValues['thinking'] = persistedThinking(config.thinking);
  }
  await harness.replaceConfigSections(sections, {
    preserveUnknown: false,
    exactKeys: replacementKeys,
    expectedValues,
  });
}

function asManaged(config: unknown): ManagedKimiConfigShape {
  return config as ManagedKimiConfigShape;
}

function persistedThinking(
  thinking: ManagedKimiConfigShape['thinking'],
): ManagedKimiConfigShape['thinking'] {
  if (thinking === undefined) return undefined;
  const persisted: NonNullable<ManagedKimiConfigShape['thinking']> = {};
  if (thinking.enabled !== undefined) persisted.enabled = thinking.enabled;
  if (thinking.effort !== undefined) persisted.effort = thinking.effort;
  if (thinking['keep'] !== undefined) persisted['keep'] = thinking['keep'];
  return persisted;
}
