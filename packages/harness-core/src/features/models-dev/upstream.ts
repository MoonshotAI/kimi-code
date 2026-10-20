import { isPlainObject } from '#/features/config/index';

import { ModelsDevError } from './errors';
import type { ModelsDevCatalog, ModelsDevProviderEntry } from './models-dev';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

const CACHE_TTL_MS = 10 * 60 * 1000;

interface ModelsDevCacheEntry {
  readonly catalog: ModelsDevCatalog;
  readonly fetchedAt: number;
}

export interface ModelsDevUpstreamProps {
  readonly userAgent?: string;
  readonly builtinCatalog?: () => unknown;
}

let cache: ModelsDevCacheEntry | undefined;
let inFlight: Promise<ModelsDevCatalog> | undefined;
let fetchImpl: typeof fetch | undefined;
let nowImpl: () => number = Date.now;

export function setModelsDevUpstreamForTest(options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}): void {
  if (options.fetchImpl !== undefined) fetchImpl = options.fetchImpl;
  if (options.now !== undefined) nowImpl = options.now;
}

export function resetModelsDevUpstreamForTest(): void {
  cache = undefined;
  inFlight = undefined;
  fetchImpl = undefined;
  nowImpl = Date.now;
}

export async function getModelsDevCatalog(
  props: ModelsDevUpstreamProps = {},
): Promise<ModelsDevCatalog> {
  const now = nowImpl();
  if (cache !== undefined && now - cache.fetchedAt < CACHE_TTL_MS) return cache.catalog;
  inFlight ??= fetchAndCache(props).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function fetchAndCache(props: ModelsDevUpstreamProps): Promise<ModelsDevCatalog> {
  const now = nowImpl();
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (props.userAgent !== undefined) headers['User-Agent'] = props.userAgent;
    const res = await (fetchImpl ?? fetch)(MODELS_DEV_URL, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload: unknown = await res.json();
    if (!isPlainObject(payload)) throw new Error('unexpected catalog payload shape');
    cache = { catalog: payload as ModelsDevCatalog, fetchedAt: now };
    return cache.catalog;
  } catch (error) {
    if (cache !== undefined) return cache.catalog;
    const builtIn = loadBuiltinCatalog(props);
    if (builtIn !== undefined) {
      cache = { catalog: builtIn, fetchedAt: now };
      return builtIn;
    }
    throw new ModelsDevError(
      'modelsDev.catalog_unavailable',
      `models.dev catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function loadBuiltinCatalog(props: ModelsDevUpstreamProps): ModelsDevCatalog | undefined {
  try {
    const value = props.builtinCatalog?.();
    return isPlainObject(value) ? (value as ModelsDevCatalog) : undefined;
  } catch {
    return undefined;
  }
}

export function modelsDevEntry(
  catalog: ModelsDevCatalog,
  id: string,
): ModelsDevProviderEntry | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, id) ? catalog[id] : undefined;
}
