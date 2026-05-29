import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import { KIMI_CODE_PLUGIN_MARKETPLACE_URL } from '#/constant/app';
import type { PluginMarketplace } from '#/utils/plugin-marketplace';

export const OFFICIAL_BADGE = 'official';
export const CURATED_BADGE = 'curated';
export const THIRD_PARTY_BADGE = 'third-party';

export type PluginTrustLabel = 'official' | 'curated' | 'third-party';

export interface PluginTrustContext {
  readonly trustedTiersBySource: ReadonlyMap<string, PluginTrustLabel>;
}

/**
 * Human-readable provenance label for a plugin, suitable for inline display
 * in `/plugins` overviews and lists.
 *
 * - github source → `github <owner>/<repo>@<ref>`
 * - zip-url with parseable URL → `via <host[:port]>`
 * - everything else → raw source kind (`local-path`, `zip-url`)
 */
export function formatPluginSourceLabel(plugin: PluginSummary): string {
  if (plugin.source === 'github' && plugin.github !== undefined) {
    return `github ${plugin.github.owner}/${plugin.github.repo}@${plugin.github.ref.value}`;
  }
  if (plugin.source === 'zip-url' && plugin.originalSource !== undefined) {
    const host = hostFromUrl(plugin.originalSource);
    if (host !== undefined) return `via ${host}`;
  }
  return plugin.source;
}

/**
 * Returns one of three trust labels for a plugin. Only plugin artifacts
 * downloaded from the built-in Kimi marketplace on code.kimi.com can receive
 * the official or curated badge. Custom marketplaces, GitHub installs, local
 * installs, and dev loopback marketplaces remain third-party.
 */
export function pluginTrustLabel(
  plugin: PluginSummary,
  context?: PluginTrustContext,
): PluginTrustLabel {
  if (plugin.source !== 'zip-url' || plugin.originalSource === undefined) {
    return 'third-party';
  }
  return context?.trustedTiersBySource.get(plugin.originalSource) ?? 'third-party';
}

export function pluginTrustContextFromMarketplace(
  marketplace: PluginMarketplace | undefined,
): PluginTrustContext | undefined {
  if (marketplace === undefined || marketplace.source !== KIMI_CODE_PLUGIN_MARKETPLACE_URL) {
    return undefined;
  }
  const trustedTiersBySource = new Map<string, PluginTrustLabel>();
  for (const entry of marketplace.plugins) {
    if (entry.tier === undefined || !isTrustedKimiPluginSource(entry.source)) continue;
    trustedTiersBySource.set(entry.source, entry.tier);
  }
  return { trustedTiersBySource };
}

export function isTrustedKimiPluginSource(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && url.hostname === 'code.kimi.com';
  } catch {
    return false;
  }
}

function hostFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.port.length > 0) return `${url.hostname}:${url.port}`;
    return url.hostname;
  } catch {
    return undefined;
  }
}
