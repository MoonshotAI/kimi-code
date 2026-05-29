import { DEFAULT_CATALOG_URL, type CatalogModel, type KimiConfig } from '@moonshot-ai/kimi-code-sdk';

const BARE_HTTP_URL_RE = /^https?:\/\/\S+$/;

export interface ConnectCatalogRequest {
  readonly url: string;
  readonly preferBuiltIn: boolean;
  readonly allowBuiltInFallback: boolean;
}

export type ConnectCatalogResolution =
  | { readonly kind: 'ok'; readonly request: ConnectCatalogRequest }
  | { readonly kind: 'error'; readonly message: string };

export function resolveConnectCatalogRequest(args: string): ConnectCatalogResolution {
  const trimmed = args.trim();

  if (trimmed === '') {
    return {
      kind: 'ok',
      request: {
        url: DEFAULT_CATALOG_URL,
        preferBuiltIn: true,
        allowBuiltInFallback: true,
      },
    };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let explicitUrl: string | undefined;
  let refreshRequested = false;

  for (const token of tokens) {
    if (token.toLowerCase() === 'refresh') {
      refreshRequested = true;
      continue;
    }

    if (BARE_HTTP_URL_RE.test(token)) {
      if (explicitUrl !== undefined) {
        return {
          kind: 'error',
          message: `Only one catalog URL can be provided. Got "${explicitUrl}" and "${token}".`,
        };
      }
      explicitUrl = token;
      continue;
    }

    if (token.startsWith('--')) {
      return {
        kind: 'error',
        message: `Unexpected flag "${token}". Use /connect [url] [refresh] instead.`,
      };
    }

    return {
      kind: 'error',
      message: `Unknown argument "${token}". Usage: /connect [url] [refresh]`,
    };
  }

  if (explicitUrl !== undefined) {
    return {
      kind: 'ok',
      request: {
        url: explicitUrl,
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    };
  }

  return {
    kind: 'ok',
    request: {
      url: DEFAULT_CATALOG_URL,
      preferBuiltIn: !refreshRequested,
      allowBuiltInFallback: true,
    },
  };
}

export interface CatalogModelSelectionInitialState {
  readonly selectedAliases: readonly string[];
  readonly defaultAlias?: string;
  readonly thinking?: boolean;
}

export function catalogProviderExistingApiKey(
  providerId: string,
  config: KimiConfig,
): string | undefined {
  const apiKey = config.providers[providerId]?.apiKey?.trim();
  return apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined;
}

/**
 * Project the current config into the initial state for the /connect
 * multi-select picker: which catalog aliases are already configured for this
 * provider, which (if any) is the default, and whether the saved default has
 * thinking on. Aliases that no longer exist in the catalog are dropped.
 */
export function catalogModelSelectionInitialState(
  providerId: string,
  models: readonly CatalogModel[],
  config: KimiConfig,
): CatalogModelSelectionInitialState {
  const aliasByModelId = new Map(models.map((model) => [model.id, `${providerId}/${model.id}`]));
  const selectedAliases: string[] = [];
  const seen = new Set<string>();
  for (const model of Object.values(config.models ?? {})) {
    if (model.provider !== providerId) continue;
    const alias = aliasByModelId.get(model.model);
    if (alias !== undefined && !seen.has(alias)) {
      selectedAliases.push(alias);
      seen.add(alias);
    }
  }

  let defaultAlias: string | undefined;
  const defaultModel =
    config.defaultModel !== undefined ? config.models?.[config.defaultModel] : undefined;
  if (defaultModel?.provider === providerId) {
    const alias = aliasByModelId.get(defaultModel.model);
    if (alias !== undefined && seen.has(alias)) defaultAlias = alias;
  }

  return {
    selectedAliases,
    defaultAlias,
    thinking: defaultAlias !== undefined ? config.defaultThinking : undefined,
  };
}

/**
 * Map providerId → number of models wired up to that provider in `config`.
 * Only providers that also have a `[providers.<id>]` entry are included, so
 * orphan model aliases (whose provider block was hand-deleted) don't get
 * badged as configured in the picker.
 */
export function configuredProviderModelCounts(config: KimiConfig): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const model of Object.values(config.models ?? {})) {
    if (config.providers[model.provider] === undefined) continue;
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  }
  return counts;
}
