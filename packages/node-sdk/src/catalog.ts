import type { KimiConfig, ModelAlias } from '@moonshot-ai/agent-core';
import {
  catalogBaseUrl,
  catalogProviderModels,
  inferWireType,
  type Catalog,
  type CatalogModel,
  type CatalogProviderEntry,
  type ModelCapability,
  type ProviderType,
} from '@moonshot-ai/kosong';

export { catalogBaseUrl, catalogProviderModels, inferWireType };
export type { Catalog, CatalogModel, CatalogProviderEntry };

export const DEFAULT_CATALOG_URL = 'https://models.dev/api.json';

export class CatalogFetchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Fetches a models.dev-style catalog. Public endpoint, no credentials needed. */
export async function fetchCatalog(
  url: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Catalog> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) {
    throw new CatalogFetchError(`Failed to fetch catalog (HTTP ${res.status}).`, res.status);
  }
  const payload: unknown = await res.json();
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Unexpected catalog response from ${url}.`);
  }
  return payload as Catalog;
}

function capabilityToStrings(capability: ModelCapability): string[] | undefined {
  const caps: string[] = [];
  if (capability.image_in) caps.push('image_in');
  if (capability.video_in) caps.push('video_in');
  if (capability.audio_in) caps.push('audio_in');
  if (capability.thinking) caps.push('thinking');
  if (capability.tool_use) caps.push('tool_use');
  return caps.length > 0 ? caps : undefined;
}

/** Builds a kimi-code model alias from a normalized catalog model. */
export function catalogModelToAlias(providerId: string, model: CatalogModel): ModelAlias {
  return {
    provider: providerId,
    model: model.id,
    maxContextSize: model.capability.max_context_tokens,
    maxOutputSize: model.maxOutputSize,
    capabilities: capabilityToStrings(model.capability),
    displayName: model.name,
  };
}

export interface ApplyCatalogProviderOptions {
  readonly providerId: string;
  readonly wire: ProviderType;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly models: readonly CatalogModel[];
  readonly selectedModelId: string;
  readonly thinking: boolean;
}

/**
 * Writes a catalog-selected provider and its model aliases into config,
 * replacing any stale aliases that belonged to the same provider. Model
 * metadata (context window, output limit, capabilities) comes from the
 * catalog, so the user does not hand-write it. Returns the default model key.
 */
/**
 * Parses an optional pruned models.dev catalog string — typically the
 * `__KIMI_CODE_BUILT_IN_CATALOG__` constant injected by tsdown at build
 * time. Returns `undefined` when the argument is missing or invalid.
 */
export function loadBuiltInCatalog(text?: string): Catalog | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as Catalog;
  } catch {
    return undefined;
  }
}

export function applyCatalogProvider(
  config: KimiConfig,
  options: ApplyCatalogProviderOptions,
): { defaultModel: string } {
  config.providers[options.providerId] = {
    type: options.wire,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
  };

  const models = config.models ?? {};
  for (const [key, alias] of Object.entries(models)) {
    if (alias.provider === options.providerId) delete models[key];
  }
  for (const model of options.models) {
    models[`${options.providerId}/${model.id}`] = catalogModelToAlias(options.providerId, model);
  }
  config.models = models;

  const defaultModel = `${options.providerId}/${options.selectedModelId}`;
  config.defaultModel = defaultModel;
  config.defaultThinking = options.thinking;
  return { defaultModel };
}
