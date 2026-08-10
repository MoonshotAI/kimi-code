/**
 * Local models.dev catalog handling — ported from `@moonshot-ai/kosong`
 * `catalog.ts` + `@moonshot-ai/kimi-code-sdk` `catalog.ts` (G-1 CLI
 * consumption cutover). Full import-resolution semantics (wire guessing,
 * endpoint adaptation, per-model provider overrides) are preserved verbatim;
 * only the local config type is trimmed to what the CLI host writes.
 */

// ── Local types (kosong `capability.ts` / `providers.ts` / `catalog.ts`) ────

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'kimi'
  | 'google-genai'
  | 'openai_responses'
  | 'vertexai'
  | 'astron';

export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  /** Total context window (input + output), used for completion budgeting. */
  readonly max_context_tokens: number;
  readonly max_input_tokens?: number;
  readonly dynamically_loaded_tools: boolean;
}

export interface CatalogModelEntry {
  readonly id?: string;
  readonly name?: string;
  readonly family?: string;
  readonly limit?: { readonly context?: number; readonly input?: number; readonly output?: number };
  readonly tool_call?: boolean;
  readonly reasoning?: boolean;
  readonly reasoning_options?: readonly CatalogReasoningOption[];
  /** Lifecycle marker: `'deprecated'` models are dropped at import. */
  readonly status?: string;
  readonly provider?: CatalogModelProviderOverride;
  readonly dynamically_loaded_tools?: boolean;
  readonly interleaved?: boolean | { readonly field?: string };
  readonly modalities?: {
    readonly input?: readonly string[];
    readonly output?: readonly string[];
  };
}

export interface CatalogReasoningOption {
  readonly type?: string;
  readonly values?: unknown;
}

export interface CatalogModelProviderOverride {
  readonly npm?: string;
  readonly api?: string;
}

export interface CatalogProviderEntry {
  readonly id?: string;
  readonly name?: string;
  /** Base URL for the provider; may be empty (some SDKs hardcode it). */
  readonly api?: string;
  /** Env var names carrying credentials — surfaced as a hint by callers. */
  readonly env?: readonly string[];
  /** models.dev SDK package id; used to infer the wire type when `type` is absent. */
  readonly npm?: string;
  /** Explicit wire type extension; inferred from `npm`/`id` when absent. */
  readonly type?: string;
  readonly models?: Record<string, CatalogModelEntry>;
}

/** Top-level catalog: `{ [providerId]: ProviderEntry }` (e.g. models.dev/api.json). */
export type Catalog = Record<string, CatalogProviderEntry>;

/** A normalized catalog model: identity plus its {@link ModelCapability}. */
export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly maxOutputSize?: number;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
  readonly protocol?: 'anthropic';
  readonly baseUrl?: string;
  readonly capability: ModelCapability;
}

/** The config surface `applyCatalogProvider` mutates (subset of KimiConfig). */
export interface CatalogConfig {
  providers: Record<string, Record<string, unknown>>;
  models?: Record<string, Record<string, unknown>>;
  defaultModel?: string;
  thinking?: { enabled?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

// ── Catalog fetch (node-sdk `catalog.ts`) ───────────────────────────────────

export const DEFAULT_CATALOG_URL = 'https://models.dev/api.json';

export class CatalogFetchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface FetchCatalogOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

/**
 * Fetches a models.dev-style catalog. Public endpoint, no credentials needed.
 */
export async function fetchCatalog(
  url: string,
  options: FetchCatalogOptions = {},
): Promise<Catalog> {
  const { signal, fetchImpl = fetch, userAgent } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (userAgent !== undefined) headers['User-Agent'] = userAgent;
  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok) {
    throw new CatalogFetchError(`Failed to fetch catalog (HTTP ${res.status}).`, res.status);
  }
  const payload: unknown = await res.json();
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Unexpected catalog response from ${url}.`);
  }
  return payload as Catalog;
}

// ── Import resolution (kosong `catalog.ts`) ─────────────────────────────────

const KNOWN_WIRE_TYPES: readonly ProviderType[] = [
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
  'astron',
];

function isWireType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (KNOWN_WIRE_TYPES as readonly string[]).includes(value);
}

function hasEmbeddingMarker(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lower = value.toLowerCase();
  return lower.includes('embedding') || /(?:^|[-_/])embed(?:$|[-_/])/.test(lower);
}

function isUsableChatModel(model: CatalogModelEntry): boolean {
  const outputModalities = model.modalities?.output;
  if (outputModalities !== undefined && !outputModalities.includes('text')) return false;
  if (model.status === 'deprecated' || model.status === 'alpha') return false;
  return (
    !hasEmbeddingMarker(model.family) &&
    !hasEmbeddingMarker(model.id) &&
    !hasEmbeddingMarker(model.name)
  );
}

/** Why a catalog import cannot proceed at all. */
export type CatalogImportInvalidReason =
  | 'unknown-explicit-type'
  | 'proprietary-sdk'
  | 'empty-base-url'
  | 'placeholder-base-url';

export type CatalogImportResolution =
  | {
      readonly kind: 'ok';
      readonly wire: ProviderType;
      readonly guessed: boolean;
      readonly baseUrl?: string;
    }
  | {
      readonly kind: 'needs-base-url';
      readonly wire: ProviderType;
      readonly guessed: boolean;
    }
  | {
      readonly kind: 'invalid';
      readonly reason: CatalogImportInvalidReason;
    };

/**
 * Resolves a catalog provider entry into an import decision: explicit `type`
 * is authoritative; otherwise npm/id heuristics; otherwise the
 * OpenAI-compatible fallback (`guessed: true`) — except proprietary SDKs
 * (Bedrock, Cohere), which are refused. Endpoints are adapted to the wire's
 * SDK convention (trailing `/v1` stripped for Anthropic).
 */
export function resolveCatalogImport(
  entry: CatalogProviderEntry,
  userBaseUrl?: string,
): CatalogImportResolution {
  const wire = resolveCatalogWire(entry);
  if (wire === undefined) {
    return {
      kind: 'invalid',
      reason:
        typeof entry.type === 'string' && entry.type.length > 0
          ? 'unknown-explicit-type'
          : 'proprietary-sdk',
    };
  }
  const guessed = inferDeclaredWireType(entry) === undefined;

  if (userBaseUrl !== undefined) {
    const trimmed = userBaseUrl.trim();
    if (trimmed.length === 0) return { kind: 'invalid', reason: 'empty-base-url' };
    if (trimmed.includes('${')) return { kind: 'invalid', reason: 'placeholder-base-url' };
    return { kind: 'ok', wire, guessed, baseUrl: adaptBaseUrlForWire(trimmed, wire) };
  }

  const catalogUrl = catalogBaseUrl(entry, wire);
  if (catalogUrl !== undefined) return { kind: 'ok', wire, guessed, baseUrl: catalogUrl };
  if (catalogEndpointRequired(entry, wire)) return { kind: 'needs-base-url', wire, guessed };
  return { kind: 'ok', wire, guessed };
}

function resolveCatalogWire(entry: CatalogProviderEntry): ProviderType | undefined {
  if (isWireType(entry.type)) return entry.type;
  if (typeof entry.type === 'string' && entry.type.length > 0) return undefined;
  const declared = inferDeclaredWireType(entry);
  if (declared !== undefined) return declared;
  const npm = (entry.npm ?? '').toLowerCase();
  if (npm.includes('amazon-bedrock') || npm.includes('cohere')) return undefined;
  return 'openai';
}

function inferDeclaredWireType(entry: CatalogProviderEntry): ProviderType | undefined {
  if (isWireType(entry.type)) return entry.type;
  const npm = (entry.npm ?? '').toLowerCase();
  const id = (entry.id ?? '').toLowerCase();
  if (npm.includes('anthropic') || id.includes('anthropic') || id.includes('claude')) {
    return 'anthropic';
  }
  if (id.includes('vertex')) return 'vertexai';
  if (npm.includes('google') || id.includes('google') || id.includes('gemini')) {
    return 'google-genai';
  }
  if (npm.includes('openai') || id.includes('openai')) return 'openai';
  return undefined;
}

/** Resolves the base URL to store, adapting the catalog `api` to the wire. */
export function catalogBaseUrl(
  entry: CatalogProviderEntry,
  wire: ProviderType,
): string | undefined {
  const api = entry.api;
  if (typeof api !== 'string' || api.length === 0 || api.includes('${')) return undefined;
  return adaptBaseUrlForWire(api, wire);
}

/** Anthropic SDK appends `/v1/messages` itself, so a trailing `/v1` is stripped. */
export function adaptBaseUrlForWire(baseUrl: string, wire: ProviderType): string {
  return wire === 'anthropic' ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl;
}

function catalogEndpointRequired(entry: CatalogProviderEntry, wire: ProviderType): boolean {
  if (typeof entry.api === 'string' && entry.api.length > 0) return true;
  const npm = (entry.npm ?? '').toLowerCase();
  if (wire === 'openai' || wire === 'openai_responses') return npm !== '@ai-sdk/openai';
  if (wire === 'anthropic') return npm !== '@ai-sdk/anthropic';
  return false;
}

/** Normalizes one catalog model entry into a {@link CatalogModel}; skips invalid entries. */
function catalogModelToCapability(model: CatalogModelEntry): CatalogModel | undefined {
  if (typeof model.id !== 'string' || model.id.length === 0) return undefined;
  const context = model.limit?.context;
  if (typeof context !== 'number' || !Number.isInteger(context) || context <= 0) return undefined;
  if (!isUsableChatModel(model)) return undefined;
  const inputs = model.modalities?.input ?? [];
  const output = model.limit?.output;
  const thinking = catalogThinkingOptions(model.reasoning_options);
  const input = model.limit?.input;
  const maxInputTokens =
    typeof input === 'number' && Number.isInteger(input) && input > 0
      ? Math.min(input, context)
      : undefined;
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name.length > 0 ? model.name : undefined,
    maxOutputSize: typeof output === 'number' && output > 0 ? output : undefined,
    reasoningKey: catalogReasoningKey(model.interleaved),
    supportEfforts: thinking.efforts,
    offEffort: thinking.offEffort,
    alwaysThinking: thinking.alwaysThinking,
    capability: {
      image_in: inputs.includes('image'),
      video_in: inputs.includes('video'),
      audio_in: inputs.includes('audio'),
      thinking:
        Boolean(model.reasoning) || thinking.efforts !== undefined || thinking.hasToggle,
      tool_use: model.tool_call ?? true,
      max_context_tokens: context,
      max_input_tokens: maxInputTokens,
      dynamically_loaded_tools: model.dynamically_loaded_tools === true,
    },
  };
}

function catalogThinkingOptions(options: CatalogModelEntry['reasoning_options']): {
  readonly efforts: readonly string[] | undefined;
  readonly offEffort: string | undefined;
  readonly hasToggle: boolean;
  readonly alwaysThinking: boolean | undefined;
} {
  if (!Array.isArray(options)) {
    return { efforts: undefined, offEffort: undefined, hasToggle: false, alwaysThinking: undefined };
  }
  let efforts: readonly string[] | undefined;
  let offEffort: string | undefined;
  let hasToggle = false;
  for (const option of options) {
    if (option?.type === 'toggle') {
      hasToggle = true;
      continue;
    }
    if (option?.type !== 'effort' || !Array.isArray(option.values)) continue;
    const hasNullTier = (option.values as unknown[]).some((value) => value === null);
    const levels = (option.values as unknown[]).filter(
      (value: unknown): value is string => typeof value === 'string' && value.length > 0,
    );
    const off = levels.find((value) => value.toLowerCase() === 'none');
    if (off !== undefined) offEffort = off;
    else if (hasNullTier) offEffort = 'none';
    const selectable = levels.filter((value) => value.toLowerCase() !== 'none');
    if (selectable.length > 0) efforts = selectable;
  }
  const alwaysThinking =
    efforts !== undefined && offEffort === undefined && !hasToggle ? true : undefined;
  return { efforts, offEffort, hasToggle, alwaysThinking };
}

function catalogReasoningKey(interleaved: CatalogModelEntry['interleaved']): string | undefined {
  if (typeof interleaved !== 'object' || interleaved === null) return undefined;
  const field = interleaved.field?.trim();
  return field !== undefined && field.length > 0 ? field : undefined;
}

/** Extracts the valid, normalized models from a catalog provider entry. */
export function catalogProviderModels(entry: CatalogProviderEntry): CatalogModel[] {
  const providerWire = resolveCatalogWire(entry);
  return Object.values(entry.models ?? {})
    .map((raw) => applyModelProviderOverride(catalogModelToCapability(raw), raw, entry, providerWire))
    .filter((model): model is CatalogModel => model !== undefined)
    .map((model) => {
      const protocol = model.protocol ?? providerWire;
      if (model.alwaysThinking === true && (protocol === 'anthropic' || protocol === 'kimi')) {
        const { alwaysThinking: _dropped, ...rest } = model;
        return rest as CatalogModel;
      }
      return model;
    });
}

function applyModelProviderOverride(
  model: CatalogModel | undefined,
  raw: CatalogModelEntry,
  entry: CatalogProviderEntry,
  providerWire: ProviderType | undefined,
): CatalogModel | undefined {
  if (model === undefined) return undefined;
  const override = raw.provider;
  if (override === undefined) return model;
  const overrideNpm = typeof override.npm === 'string' ? override.npm.toLowerCase() : undefined;
  if (
    overrideNpm !== undefined &&
    (overrideNpm.includes('amazon-bedrock') || overrideNpm.includes('cohere'))
  ) {
    return undefined;
  }
  const overrideWire =
    overrideNpm !== undefined ? (inferOverrideWire(overrideNpm) ?? 'openai') : providerWire;
  if (overrideWire === undefined) return model;
  const rawApi = override.api;
  const api = rawApi ?? entry.api;
  const usableApi =
    typeof api === 'string' && api.length > 0 && !api.includes('${') ? api : undefined;

  if (overrideWire === providerWire) {
    if (typeof rawApi === 'string' && rawApi.includes('${')) return undefined;
    if (usableApi !== undefined && usableApi !== entry.api) {
      return { ...model, baseUrl: adaptBaseUrlForWire(usableApi, overrideWire) };
    }
    return model;
  }

  if (overrideWire === 'anthropic' && usableApi !== undefined) {
    return { ...model, protocol: 'anthropic', baseUrl: adaptBaseUrlForWire(usableApi, 'anthropic') };
  }
  return undefined;
}

function inferOverrideWire(npm: string): ProviderType | undefined {
  const normalized = npm.toLowerCase();
  if (normalized.includes('anthropic')) return 'anthropic';
  if (normalized.includes('vertex')) return 'vertexai';
  if (normalized.includes('google')) return 'google-genai';
  if (normalized.includes('openai')) return 'openai';
  return undefined;
}

// ── Config application (node-sdk `catalog.ts`) ──────────────────────────────

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

/** Builds a kimi-code model alias from a normalized catalog model. */
export function catalogModelToAlias(providerId: string, model: CatalogModel): Record<string, unknown> {
  const caps = capabilityToStrings(model.capability);
  return {
    provider: providerId,
    model: model.id,
    maxContextSize: model.capability.max_context_tokens,
    maxInputSize: model.capability.max_input_tokens,
    maxOutputSize: model.maxOutputSize,
    capabilities:
      model.alwaysThinking === true
        ? caps?.map((cap) => (cap === 'thinking' ? 'always_thinking' : cap))
        : caps,
    displayName: model.name,
    reasoningKey: model.reasoningKey,
    supportEfforts: model.supportEfforts === undefined ? undefined : [...model.supportEfforts],
    offEffort: model.offEffort,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
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
 * Writes a catalog-selected provider and its model aliases into `config` and
 * marks it the default. Mutates the passed-in `config` only; callers that
 * persist via a deep-merge patch must remove stale provider ids first.
 */
export function applyCatalogProvider(
  config: CatalogConfig,
  options: ApplyCatalogProviderOptions,
): { defaultModel: string } {
  config.providers[options.providerId] = {
    type: options.wire,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
  };

  const models = config.models ?? {};
  for (const [key, alias] of Object.entries(models)) {
    if (alias['provider'] === options.providerId) delete models[key];
  }
  for (const model of options.models) {
    models[`${options.providerId}/${model.id}`] = catalogModelToAlias(options.providerId, model);
  }
  config.models = models;

  const defaultModel = `${options.providerId}/${options.selectedModelId}`;
  config.defaultModel = defaultModel;
  config.thinking = { ...config.thinking, enabled: options.thinking };
  return { defaultModel };
}
