/**
 * `#/utils/plugin-marketplace` — CLI-side wrapper over the shared plugin
 * marketplace client/parser (`@moonshot-ai/agent-core-v2`,
 * `app/plugin/marketplace`). The shared module owns catalog reading, the
 * lenient entry normalization, source resolution, and version derivation;
 * this wrapper adds only the CLI's configured-source resolution (option →
 * env → production default), the source-checkout fallback for offline dev,
 * and the caller-supplied built-in capability entry injection.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  parsePluginMarketplace,
  readPluginMarketplace,
  withBuiltInEntries,
  withLatestVersions,
  type MarketplaceLocation,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
} from '@moonshot-ai/agent-core-v2/app/plugin/marketplace';

import {
  KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
  kimiCodePluginMarketplaceUrl,
} from '#/constant/app';

export {
  computeUpdateStatus,
  PLUGIN_MARKETPLACE_TIERS,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
  type PluginMarketplaceTier,
  type MarketplaceUpdateStatus,
} from '@moonshot-ai/agent-core-v2/app/plugin/marketplace';

export interface LoadPluginMarketplaceOptions {
  readonly workDir: string;
  readonly source?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Built-in capability rows to inject, supplied by the caller from the
   * engine's capability registry (this util owns no product knowledge).
   * Undefined means no injection.
   */
  readonly builtInEntries?: readonly PluginMarketplaceEntry[];
}

export async function loadPluginMarketplace(
  options: LoadPluginMarketplaceOptions,
): Promise<PluginMarketplace> {
  const configuredSource = options.source ?? process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV];
  const source = configuredSource ?? kimiCodePluginMarketplaceUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  let read: { raw: string; location: MarketplaceLocation };
  try {
    read = await readPluginMarketplace({
      source,
      workDir: options.workDir,
      fetchImpl,
      sourceCheckoutLocation:
        configuredSource === undefined ? getSourceCheckoutMarketplaceLocation : undefined,
    });
  } catch (error) {
    if (options.builtInEntries !== undefined) {
      // The built-in entries do not come from the catalog — keep them
      // visible when the catalog itself is unreachable.
      return withBuiltInEntries({ source, plugins: [] }, options.builtInEntries);
    }
    throw error;
  }
  const marketplace = await withLatestVersions(
    parsePluginMarketplace(read.raw, read.location),
    fetchImpl,
  );
  return options.builtInEntries !== undefined
    ? withBuiltInEntries(marketplace, options.builtInEntries)
    : marketplace;
}

async function getSourceCheckoutMarketplaceLocation(): Promise<MarketplaceLocation | undefined> {
  const marketplacePath = resolve(import.meta.dirname, '../../../../plugins/marketplace.json');
  const info = await stat(marketplacePath).catch(() => undefined);
  if (info?.isFile() !== true) return undefined;
  return { raw: marketplacePath, kind: 'local', resolved: marketplacePath };
}
