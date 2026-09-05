import { isRecord } from './utils';

/**
 * Self-contained models.dev catalog lookup for OpenAI-compatible catalog
 * refresh (`/refresh-catalog`). Kept inside `@moonshot-ai/kimi-code-oauth` so
 * the package stays free of `agent-core` / SDK dependencies. Mirrors the
 * catalog resolution in `agent-core-v2`'s kosongConfig, but only the narrow
 * "lookup a single model's display name + capabilities" slice needed here.
 */

interface ModelsDevModelEntry {
  readonly id?: string;
  readonly name?: string;
  readonly limit?: { readonly context?: number; readonly input?: number; readonly output?: number };
  readonly tool_call?: boolean;
  readonly reasoning?: boolean;
  readonly status?: string;
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
  readonly family?: string;
}

interface ModelsDevProviderEntry {
  readonly models?: Record<string, ModelsDevModelEntry>;
}

type ModelsDevCatalog = Record<string, ModelsDevProviderEntry>;

export interface ModelsDevModelInfo {
  readonly displayName?: string;
  readonly capabilities?: string[];
  readonly context?: number;
}

const MODELS_DEV_URL = 'https://models.dev/api.json';

declare const __KIMI_CODE_BUILT_IN_CATALOG__: string | undefined;

function loadBuiltInCatalog(): ModelsDevCatalog | undefined {
  const text =
    typeof __KIMI_CODE_BUILT_IN_CATALOG__ === 'string' ? __KIMI_CODE_BUILT_IN_CATALOG__ : undefined;
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? (parsed as ModelsDevCatalog) : undefined;
  } catch {
    return undefined;
  }
}

let catalogMemo: ModelsDevCatalog | undefined | null = null;

function builtInCatalog(): ModelsDevCatalog | undefined {
  if (catalogMemo === null) catalogMemo = loadBuiltInCatalog();
  return catalogMemo;
}

function toCapabilities(model: ModelsDevModelEntry): string[] | undefined {
  const caps = new Set<string>();
  const inputs = model.modalities?.input ?? [];
  if (inputs.includes('image')) caps.add('image_in');
  if (inputs.includes('video')) caps.add('video_in');
  if (inputs.includes('audio')) caps.add('audio_in');
  if (Boolean(model.reasoning) || model.reasoning !== undefined) caps.add('thinking');
  caps.add('tool_use');
  if (model.status === 'deprecated' || model.status === 'alpha') return undefined;
  return caps.size > 0 ? [...caps] : undefined;
}

function entryFor(catalog: ModelsDevCatalog, providerId: string): ModelsDevProviderEntry | undefined {
  if (!isRecord(catalog[providerId])) return undefined;
  return catalog[providerId] as ModelsDevProviderEntry;
}

function modelInfoFrom(
  entry: ModelsDevProviderEntry | undefined,
  modelId: string,
): ModelsDevModelInfo | undefined {
  if (entry?.models === undefined) return undefined;
  const raw = entry.models[modelId];
  if (!isRecord(raw)) return undefined;
  const rawName = raw['name'];
  const displayName =
    typeof rawName === 'string' && rawName.length > 0 ? rawName : undefined;
  // `capabilities` and `context` are independent signals — a model that is
  // flagged `deprecated` / `alpha` in the catalog has no capabilities here
  // (so we drop the capabilities hint) but can still carry a `limit.context`
  // we want to surface. Read both, then return only the fields that have a
  // value so the caller does not have to distinguish "absent" from
  // "explicitly undefined".
  const capabilities = toCapabilities(raw as ModelsDevModelEntry);
  const limit = isRecord(raw['limit']) ? (raw['limit'] as Record<string, unknown>) : undefined;
  const rawContext = limit?.['context'];
  const context = typeof rawContext === 'number' && rawContext > 0 ? rawContext : undefined;
  if (displayName === undefined && capabilities === undefined && context === undefined) {
    return undefined;
  }
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}

/**
 * Look up a model in the models.dev catalog by provider + model id.
 *
 * Free models are matched loosely: many providers append `:free` (OpenRouter,
 * OpenAI-compatible) or `-free` (opencode) to the model id, but models.dev keys
 * the base model without that suffix. So the lookup tries, in order:
 *  1. the exact id (`tencent/hy3:free`),
 *  2. the id with a trailing `:free` stripped (`tencent/hy3`),
 *  3. the id with a trailing `-free` stripped (`tencent/hy3`),
 *  4. the bare id as-is (no catalog match → undefined).
 * A provider-reported display name still takes priority over the catalog name
 * at the call site; this only supplies the fallback name + capabilities.
 */
export function lookupModelsDevModel(
  providerId: string,
  modelId: string,
): ModelsDevModelInfo | undefined {
  const catalog = builtInCatalog();
  if (catalog === undefined) return undefined;
  const entry = entryFor(catalog, providerId);
  if (entry === undefined) return undefined;
  return (
    modelInfoFrom(entry, modelId) ??
    modelInfoFrom(entry, modelId.replace(/:free$/i, '')) ??
    modelInfoFrom(entry, modelId.replace(/-free$/i, ''))
  );
}

/**
 * Fetch the live models.dev catalog (used to warm the built-in memo when a
 * provider/operation needs fresher data than the bundled snapshot). Returns the
 * built-in catalog unchanged if the network fetch fails.
 */
export async function refreshModelsDevCatalog(
  fetchImpl: typeof fetch = fetch,
  userAgent?: string,
): Promise<ModelsDevCatalog> {
  const builtIn = builtInCatalog();
  try {
    const res = await fetchImpl(MODELS_DEV_URL, {
      headers: {
        Accept: 'application/json',
        ...(userAgent !== undefined ? { 'User-Agent': userAgent } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return builtIn ?? {};
    const payload: unknown = await res.json();
    if (!isRecord(payload)) return builtIn ?? {};
    catalogMemo = payload as ModelsDevCatalog;
    return catalogMemo;
  } catch {
    return builtIn ?? {};
  }
}
