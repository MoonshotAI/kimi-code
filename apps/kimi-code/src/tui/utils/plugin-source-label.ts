import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

export const OFFICIAL_BADGE = 'official';
export const CURATED_BADGE = 'curated';
export const THIRD_PARTY_BADGE = 'third-party';

export type PluginTrustLabel = 'official' | 'curated' | 'third-party';

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
 * Returns one of three trust labels for a plugin:
 *
 *   - `official`    — `marketplace.tier === 'official'`. Kimi-built and
 *                     -maintained code.
 *   - `curated`     — `marketplace.tier === 'curated'`. Third-party code that
 *                     Kimi reviewed and shipped through the marketplace, but
 *                     does not own ongoing maintenance for.
 *   - `third-party` — no marketplace context. Installed via raw URL, GitHub,
 *                     or local path (or installed before the marketplace
 *                     field existed; we deliberately don't backfill).
 *
 * Note that a marketplace re-install replaces the `marketplace` field on
 * the record, and a CLI re-install clears it. So this label always reflects
 * the most recent install path.
 */
export function pluginTrustLabel(plugin: PluginSummary): PluginTrustLabel {
  const tier = plugin.marketplace?.tier;
  if (tier === 'official') return 'official';
  if (tier === 'curated') return 'curated';
  return 'third-party';
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
