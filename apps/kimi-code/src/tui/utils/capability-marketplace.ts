import type { CapabilityStatus, PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import type { PluginMarketplaceEntry } from '#/utils/plugin-marketplace';

type CapabilityId = CapabilityStatus['id'];

const CAPABILITY_PLUGIN_IDS: Readonly<Record<CapabilityId, readonly string[]>> = {
  'kimi-webbridge': ['kimi-browser-extension', 'kimi-webbridge'],
  'kimi-cu': ['kimi-cu', 'kimi-cu-win'],
};

const CAPABILITY_PLUGIN_ID_SET = new Set(Object.values(CAPABILITY_PLUGIN_IDS).flat());

export function capabilityIdForMarketplaceEntry(
  entryId: string,
  catalogIsDefault: boolean,
): CapabilityId | undefined {
  if (!catalogIsDefault) return undefined;
  switch (entryId) {
    case 'kimi-browser-extension':
      return 'kimi-webbridge';
    case 'kimi-cu':
    case 'kimi-cu-win':
      return 'kimi-cu';
    default:
      return undefined;
  }
}

export function dedupeCapabilityMarketplaceEntries(
  entries: readonly PluginMarketplaceEntry[],
  capabilities: readonly CapabilityStatus[],
  catalogIsDefault: boolean,
): readonly PluginMarketplaceEntry[] {
  return entries.filter((entry) => {
    if (entry.id === 'kimi-webbridge') return false;
    if (!catalogIsDefault) return true;
    const capabilityId = capabilityIdForMarketplaceEntry(entry.id, true);
    if (capabilityId === undefined) return true;
    const capability = capabilities.find((candidate) => candidate.id === capabilityId);
    return capability?.supported === true && capability.pluginId === entry.id;
  });
}

export function installedPluginForMarketplaceEntry(
  entryId: string,
  installed: readonly PluginSummary[],
  capability: CapabilityStatus | undefined,
  catalogIsDefault: boolean,
): PluginSummary | undefined {
  const capabilityId = capabilityIdForMarketplaceEntry(entryId, catalogIsDefault);
  if (capabilityId === undefined) return installed.find((plugin) => plugin.id === entryId);
  const pluginIds =
    capability?.pluginId === undefined
      ? CAPABILITY_PLUGIN_IDS[capabilityId]
      : [capability.pluginId, ...CAPABILITY_PLUGIN_IDS[capabilityId]];
  for (const pluginId of new Set(pluginIds)) {
    const plugin = installed.find((candidate) => candidate.id === pluginId);
    if (plugin !== undefined) return plugin;
  }
  return undefined;
}

export function isCapabilityPluginId(pluginId: string): boolean {
  return CAPABILITY_PLUGIN_ID_SET.has(pluginId);
}
