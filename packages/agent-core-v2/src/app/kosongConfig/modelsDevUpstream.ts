/**
 * `kosongConfig` domain — models.dev upstream: fetch the third-party
 * directory, in-memory cache, built-in snapshot fallback, and the pruned
 * item mapping behind the import service's browse methods.
 */

import { CoreErrors } from '#/_base/errors/codes';
import { BugIndicatingError, Error2 } from '#/_base/errors/errors';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ModelRecord } from '#/kosong/model/model';

import { BUILT_IN_MODELS_DEV_JSON } from './builtInModelsDev';
import { ModelsDevImportErrors } from './errors';
import {
  modelsDevProviderModels,
  resolveModelsDevImport,
  type ModelsDevCatalog,
  type ModelsDevModel,
  type ModelsDevProviderEntry,
} from './modelsDev';
import type { ModelsDevModelItem, ModelsDevProviderItem } from './modelsDevImport';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 10 * 60 * 1000;
export const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

export function loadBuiltInModelsDevCatalog(text?: string): ModelsDevCatalog | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as ModelsDevCatalog;
  } catch {
    return undefined;
  }
}

interface ModelsDevCacheEntry {
  readonly catalog: ModelsDevCatalog;
  readonly fetchedAt: number;
}

let cache: ModelsDevCacheEntry | undefined;
let inFlight: Promise<ModelsDevCatalog> | undefined;
let builtInMemo: ModelsDevCatalog | undefined | null = null;
let fetchImpl: typeof fetch = fetch;
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
  builtInMemo = null;
  fetchImpl = fetch;
  nowImpl = Date.now;
}

export function upstreamFetch(): typeof fetch {
  return fetchImpl;
}

export async function getModelsDevCatalog(): Promise<ModelsDevCatalog> {
  const now = nowImpl();
  if (cache !== undefined && now - cache.fetchedAt < CACHE_TTL_MS) return cache.catalog;
  inFlight ??= fetchAndCache().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function fetchAndCache(): Promise<ModelsDevCatalog> {
  const now = nowImpl();
  try {
    const res = await fetchImpl(MODELS_DEV_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'kimi-code-kap-server' },
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error2(CoreErrors.codes.INTERNAL, `HTTP ${res.status}`, {
        details: { status: res.status },
      });
    }
    const payload: unknown = await res.json();
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error2(CoreErrors.codes.INTERNAL, 'unexpected catalog payload shape');
    }
    cache = { catalog: payload as ModelsDevCatalog, fetchedAt: now };
    return cache.catalog;
  } catch (err) {
    if (cache !== undefined) return cache.catalog;
    const builtIn = builtInCatalog();
    if (builtIn !== undefined) {
      cache = { catalog: builtIn, fetchedAt: now };
      return builtIn;
    }
    throw new Error2(
      ModelsDevImportErrors.codes.CATALOG_UNAVAILABLE,
      `models.dev catalog unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function builtInCatalog(): ModelsDevCatalog | undefined {
  if (builtInMemo === null) builtInMemo = loadBuiltInModelsDevCatalog(BUILT_IN_MODELS_DEV_JSON);
  return builtInMemo;
}

export function modelsDevEntry(
  catalog: ModelsDevCatalog,
  id: string,
): ModelsDevProviderEntry | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, id) ? catalog[id] : undefined;
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

function toModelItem(model: ModelsDevModel): ModelsDevModelItem {
  const caps = capabilityToStrings(model.capability);
  return {
    ...(model.name !== undefined ? { name: model.name } : {}),
    ...(caps !== undefined ? { capabilities: caps } : {}),
    id: model.id,
    max_context_size: model.capability.max_context_tokens,
    reasoning: model.capability.thinking,
  };
}

export function toModelsDevProviderItem(
  id: string,
  entry: ModelsDevProviderEntry,
): ModelsDevProviderItem {
  const resolution = resolveModelsDevImport(entry);
  const models = modelsDevProviderModels(entry).map(toModelItem);
  const base = {
    id,
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
  throw new BugIndicatingError(
    `unhandled models.dev import resolution: ${JSON.stringify(resolution)}`,
  );
}


export function modelsDevModelToRecord(providerId: string, model: ModelsDevModel): ModelRecord {
  const caps = capabilityToStrings(model.capability);
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
