import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
import {
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
} from '@moonshot-ai/kimi-code-oauth';
import {
  isMissingMarketplaceTokenError,
  parsePluginMarketplace,
  readPluginMarketplace,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
} from '@moonshot-ai/agent-core-v2/app/plugin/marketplace';

import {
  KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
  kimiCodePluginMarketplaceUrl,
} from '#/constant/app';
import { currentKimiManagedRuntimeAuth } from '#/utils/region';

export {
  computeUpdateStatus,
  PLUGIN_MARKETPLACE_CLASSIFICATIONS,
  PLUGIN_MARKETPLACE_TIERS,
  type PluginMarketplace,
  type PluginMarketplaceClassification,
  type PluginMarketplaceEntry,
  type PluginMarketplaceTier,
  type MarketplaceUpdateStatus,
} from '@moonshot-ai/agent-core-v2/app/plugin/marketplace';

export interface LoadPluginMarketplaceOptions {
  readonly workDir: string;
  readonly source?: string;
  readonly fetchImpl?: typeof fetch;
  readonly getAccessToken?: () => Promise<string | undefined>;
}

export async function loadPluginMarketplace(
  options: LoadPluginMarketplaceOptions,
): Promise<PluginMarketplace> {
  const configuredSource = options.source ?? process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV];
  const source = configuredSource ?? kimiCodePluginMarketplaceUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  const read = await readPluginMarketplace({
    source,
    workDir: options.workDir,
    fetchImpl: async (input, init) => {
      if (configuredSource !== undefined) return fetchImpl(input, init);
      const getAccessToken = options.getAccessToken ?? defaultManagedAccessToken;
      const headers = new Headers(init?.headers);
      let token: string | undefined;
      try {
        token = await getAccessToken();
      } catch (error) {
        if (!isMissingMarketplaceTokenError(error)) throw error;
      }
      if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
      headers.set('Accept', 'application/json');
      return fetchImpl(input, { ...init, headers });
    },
  });
  return parsePluginMarketplace(read.raw, read.location);
}

export function pluginMarketplaceCliDescription(
  entry: PluginMarketplaceEntry,
  locale = 'en-US',
): string | undefined {
  const block = findLocaleBlock(entry, locale);
  if (entry.locale === undefined || sameLocale(locale, entry.locale.defaultLocale)) {
    return entry.cliDescription ?? nonEmptyString(block?.['cliDescription']);
  }
  return nonEmptyString(block?.['cliDescription']);
}

function findLocaleBlock(
  entry: PluginMarketplaceEntry,
  locale: string,
): Record<string, unknown> | undefined {
  if (entry.locale === undefined) return undefined;
  const normalized = normalizedLocale(locale);
  const base = normalized.split('-')[0];
  const candidates = base === normalized ? [normalized] : [normalized, base];
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(entry.locale)) {
      const normalizedKey = normalizedLocale(key);
      if (normalizedKey !== candidate && normalizedKey.split('-')[0] !== candidate) continue;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

function sameLocale(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  const normalizedA = normalizedLocale(a);
  const normalizedB = normalizedLocale(b);
  return normalizedA === normalizedB || normalizedA.split('-')[0] === normalizedB.split('-')[0];
}

function normalizedLocale(value: string): string {
  return value.replaceAll('_', '-').toLowerCase();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

async function defaultManagedAccessToken(): Promise<string> {
  const auth = currentKimiManagedRuntimeAuth();
  return new KimiOAuthToolkit({ homeDir: resolveKimiHome() })
    .tokenProvider(KIMI_CODE_PROVIDER_NAME, auth.oauthRef)
    .getAccessToken();
}
