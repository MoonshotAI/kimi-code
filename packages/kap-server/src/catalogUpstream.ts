/**
 * models.dev catalog upstream — fetch, in-memory cache, built-in snapshot
 * fallback, and the pruned item mapping for the `/catalog/providers` routes.
 *
 * The normalization decisions (wire resolution, base-URL adaptation, model
 * pruning) all come from `@moonshot-ai/kosong`, the same functions the
 * TUI/CLI import paths use, so the GUI import stays behavior-identical.
 * The small glue pieces the node-sdk keeps (`fetchCatalog`,
 * `catalogModelToAlias`, `loadBuiltInCatalog`) are re-implemented here
 * because the node-sdk is the v1 in-process SDK and pulls a runtime the
 * server must not load; the config write itself is orchestrated by the
 * route through `IConfigService` sections (never `applyCatalogProvider`,
 * which would also move the global default pointers).
 */

import {
  catalogProviderModels,
  resolveCatalogImport,
  type Catalog,
  type CatalogModel,
  type CatalogProviderEntry,
  type ModelCapability,
} from '@moonshot-ai/kosong';
import type { ModelRecord } from '@moonshot-ai/agent-core-v2';

import { BUILT_IN_CATALOG_JSON } from './built-in-catalog';

export const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Shared upstream timeout for both the catalog and registry fetches. */
export const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

/** Thrown when neither the network nor a snapshot can produce a catalog. */
export class CatalogUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `models.dev catalog unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'CatalogUnavailableError';
  }
}

/** Parses a built-in catalog snapshot string; undefined when missing/invalid. */
export function loadBuiltInCatalog(text?: string): Catalog | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as Catalog;
  } catch {
    return undefined;
  }
}

interface CatalogCacheEntry {
  readonly catalog: Catalog;
  readonly fetchedAt: number;
}

let cache: CatalogCacheEntry | undefined;
let inFlight: Promise<Catalog> | undefined;
let builtInMemo: Catalog | undefined | null = null;
let fetchImpl: typeof fetch = fetch;
let nowImpl: () => number = Date.now;

/**
 * Test hook: swap the fetch/clock used by `getCatalog`. The cache is kept, so
 * TTL behavior can be exercised by advancing the injected clock; pair with
 * `resetCatalogUpstreamForTest` in test setup/teardown for isolation.
 */
export function setCatalogUpstreamForTest(options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}): void {
  if (options.fetchImpl !== undefined) fetchImpl = options.fetchImpl;
  if (options.now !== undefined) nowImpl = options.now;
}

/** Test hook: drop the cache and restore the real fetch/clock. */
export function resetCatalogUpstreamForTest(): void {
  cache = undefined;
  inFlight = undefined;
  builtInMemo = null;
  fetchImpl = fetch;
  nowImpl = Date.now;
}

/** The currently injected fetch — shared by the catalog and registry upstreams. */
export function upstreamFetch(): typeof fetch {
  return fetchImpl;
}

/**
 * Returns the models.dev catalog: fresh cache hit → one shared network fetch
 * (concurrent misses join the same in-flight promise; cached on success) →
 * stale cache on fetch failure → built-in snapshot → throws
 * `CatalogUnavailableError`.
 */
export async function getCatalog(): Promise<Catalog> {
  const now = nowImpl();
  if (cache !== undefined && now - cache.fetchedAt < CACHE_TTL_MS) return cache.catalog;
  inFlight ??= fetchAndCache().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function fetchAndCache(): Promise<Catalog> {
  const now = nowImpl();
  try {
    const res = await fetchImpl(CATALOG_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'kimi-code-kap-server' },
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload: unknown = await res.json();
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('unexpected catalog payload shape');
    }
    cache = { catalog: payload as Catalog, fetchedAt: now };
    return cache.catalog;
  } catch (err) {
    if (cache !== undefined) return cache.catalog;
    const builtIn = builtInCatalog();
    if (builtIn !== undefined) {
      // Cache the snapshot too — an offline install would otherwise pay the
      // full upstream timeout on every catalog call before falling back.
      cache = { catalog: builtIn, fetchedAt: now };
      return builtIn;
    }
    throw new CatalogUnavailableError(err);
  }
}

/** The built-in snapshot, parsed at most once per process (it can be MBs). */
function builtInCatalog(): Catalog | undefined {
  if (builtInMemo === null) builtInMemo = loadBuiltInCatalog(BUILT_IN_CATALOG_JSON);
  return builtInMemo;
}

/** Own-property lookup — a parsed catalog still carries the Object prototype
 *  chain, so `catalog['constructor']` must not masquerade as a real entry. */
export function catalogEntry(catalog: Catalog, id: string): CatalogProviderEntry | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, id) ? catalog[id] : undefined;
}

// ---------------------------------------------------------------------------
// Pruned item mapping (wire shape of GET /catalog/providers)
// ---------------------------------------------------------------------------

export interface CatalogModelItem {
  readonly id: string;
  readonly name?: string;
  readonly max_context_size: number;
  readonly capabilities?: readonly string[];
  readonly reasoning: boolean;
}

export interface CatalogProviderItem {
  readonly id: string;
  readonly name: string;
  readonly wire_type: string | null;
  /** True when the wire came from the OpenAI-compatible fallback, not a declaration. */
  readonly guessed: boolean;
  /** True when the import form must collect a base URL from the user. */
  readonly needs_base_url: boolean;
  /** True when the entry cannot be imported at all (greyed out by clients). */
  readonly rejected: boolean;
  readonly reject_reason: string | null;
  /** The credential env var the vendor conventionally uses, as a hint. */
  readonly env_key: string | null;
  readonly models: readonly CatalogModelItem[];
}

function capabilityToStrings(capability: ModelCapability): string[] | undefined {
  const caps: string[] = [];
  if (capability.image_in) caps.push('image_in');
  if (capability.video_in) caps.push('video_in');
  if (capability.audio_in) caps.push('audio_in');
  if (capability.thinking) caps.push('thinking');
  if (capability.tool_use) caps.push('tool_use');
  if (capability.dynamically_loaded_tools === true) caps.push('dynamically_loaded_tools');
  return caps.length > 0 ? caps : undefined;
}

function toModelItem(model: CatalogModel): CatalogModelItem {
  const caps = capabilityToStrings(model.capability);
  return {
    ...(model.name !== undefined ? { name: model.name } : {}),
    ...(caps !== undefined ? { capabilities: caps } : {}),
    id: model.id,
    max_context_size: model.capability.max_context_tokens,
    reasoning: model.capability.thinking,
  };
}

/** Maps one catalog entry to its pruned REST item, resolving import eligibility. */
export function toCatalogProviderItem(id: string, entry: CatalogProviderEntry): CatalogProviderItem {
  const resolution = resolveCatalogImport(entry);
  const models = catalogProviderModels(entry).map(toModelItem);
  const base = {
    id,
    // An empty-string upstream name is as useless as a missing one — fall back.
    name: entry.name || id,
    env_key: entry.env?.[0] ?? null,
    models,
  };
  switch (resolution.kind) {
    case 'ok':
      return {
        ...base,
        wire_type: resolution.wire,
        guessed: resolution.guessed,
        needs_base_url: false,
        rejected: false,
        reject_reason: null,
      };
    case 'needs-base-url':
      return {
        ...base,
        wire_type: resolution.wire,
        guessed: resolution.guessed,
        needs_base_url: true,
        rejected: false,
        reject_reason: null,
      };
    case 'invalid':
      return {
        ...base,
        wire_type: null,
        guessed: false,
        needs_base_url: false,
        rejected: true,
        reject_reason: resolution.reason,
      };
  }
}

// ---------------------------------------------------------------------------
// Config record mapping (used by the import route)
// ---------------------------------------------------------------------------

/**
 * Builds the persisted model alias record for an imported catalog model —
 * the same field set as the node-sdk's `catalogModelToAlias`, so a
 * GUI-imported provider is indistinguishable from a TUI-imported one.
 */
export function catalogModelToRecord(providerId: string, model: CatalogModel): ModelRecord {
  const caps = capabilityToStrings(model.capability);
  // A model that always reasons advertises `always_thinking` instead of
  // `thinking`, so the UI locks thinking on and offers no off option.
  const capabilities =
    model.alwaysThinking === true
      ? caps?.map((cap) => (cap === 'thinking' ? 'always_thinking' : cap))
      : caps;
  const record: ModelRecord = {
    provider: providerId,
    model: model.id,
    maxContextSize: model.capability.max_context_tokens,
  };
  if (model.capability.max_input_tokens !== undefined) {
    record.maxInputSize = model.capability.max_input_tokens;
  }
  if (model.maxOutputSize !== undefined) record.maxOutputSize = model.maxOutputSize;
  if (capabilities !== undefined) record.capabilities = capabilities;
  if (model.name !== undefined) record.displayName = model.name;
  if (model.reasoningKey !== undefined) record.reasoningKey = model.reasoningKey;
  if (model.supportEfforts !== undefined) record.supportEfforts = [...model.supportEfforts];
  if (model.offEffort !== undefined) record.offEffort = model.offEffort;
  if (model.protocol !== undefined) record.protocol = model.protocol;
  if (model.baseUrl !== undefined) record.baseUrl = model.baseUrl;
  return record;
}
