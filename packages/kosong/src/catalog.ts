import type { ModelCapability } from './capability';
import type { ProviderType } from './providers';

/**
 * models.dev-style catalog: a public map of provider/model metadata. Callers
 * consume a snapshot of this shape to populate provider + model configuration
 * without hand-writing context windows or capabilities.
 */
export interface CatalogModelEntry {
  readonly id?: string;
  readonly name?: string;
  readonly family?: string;
  readonly limit?: { readonly context?: number; readonly input?: number; readonly output?: number };
  readonly tool_call?: boolean;
  readonly reasoning?: boolean;
  /**
   * models.dev reasoning declaration: `[{ type: 'toggle' }, ...]` entries.
   * Only `{ type: 'effort', values: [...] }` maps onto concrete thinking
   * effort levels; `toggle` is the boolean form and `budget_tokens` a token
   * budget — neither yields an effort list.
   */
  readonly reasoning_options?: readonly CatalogReasoningOption[];
  /** Lifecycle marker: `'deprecated'` models are dropped at import. */
  readonly status?: string;
  /**
   * Per-model serving override on gateway providers (zenmux, opencode, …):
   * the model speaks a different protocol (`npm`) and/or lives on a different
   * endpoint (`api`) than the provider default.
   */
  readonly provider?: CatalogModelProviderOverride;
  /** Accepts message-level tool declarations (`messages[].tools`). Defaults to false. */
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
  /** Declared thinking effort levels from `reasoning_options`, when present. */
  readonly supportEfforts?: readonly string[];
  /**
   * The effort value that encodes "thinking off" for this model (models.dev
   * declares it as the `'none'` entry in `reasoning_options`). Undefined when
   * the model has no such value — then `off` simply sends no effort field.
   */
  readonly offEffort?: string;
  /**
   * True when the model declares effort levels without any way to disable
   * thinking (no `toggle` entry and no `'none'` value) — it always reasons at
   * some level, so the UI must not offer an off option.
   */
  readonly alwaysThinking?: boolean;
  /**
   * Per-model protocol override from the catalog entry's `provider` field
   * (gateway providers serving this model over the Anthropic protocol).
   */
  readonly protocol?: 'anthropic';
  /** Endpoint paired with {@link protocol}, adapted to the wire's SDK convention. */
  readonly baseUrl?: string;
  readonly capability: ModelCapability;
}

const KNOWN_WIRE_TYPES = [
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
] as const satisfies readonly ProviderType[];

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
  // Deprecated models are shut down or scheduled for removal upstream, and
  // alpha models are pre-release (the reference consumer hides both by
  // default); do not offer them for new imports. Existing configs are
  // cleaned up on refresh because the alias is no longer listed upstream.
  if (model.status === 'deprecated' || model.status === 'alpha') return false;
  return (
    !hasEmbeddingMarker(model.family) &&
    !hasEmbeddingMarker(model.id) &&
    !hasEmbeddingMarker(model.name)
  );
}

/**
 * Resolves a catalog provider entry to a supported wire type. Honors an
 * explicit `type`, otherwise infers from `npm`/`id`. models.dev omits `type`
 * for vendor-specific SDKs; most of those speak OpenAI-compatible chat
 * completions, so unknown providers fall back to `'openai'` (reported via
 * {@link isGuessedWireType} so callers can surface the guess). The only
 * `undefined` results are SDKs known to be non-OpenAI proprietary (e.g.
 * Amazon Bedrock), where the fallback would write a config that can never
 * work — callers keep refusing those instead.
 */
export function inferWireType(entry: CatalogProviderEntry): ProviderType | undefined {
  // An explicit `type` is authoritative: honored when known, refused when
  // not — a future catalog protocol must never be silently rewired through
  // npm/id inference or the fallback below.
  if (isWireType(entry.type)) return entry.type;
  if (typeof entry.type === 'string' && entry.type.length > 0) return undefined;
  const declared = inferDeclaredWireType(entry);
  if (declared !== undefined) return declared;
  // SDKs known to be non-OpenAI proprietary — the fallback below would write
  // a config that can never work (Bedrock Converse API, Cohere's native chat
  // API), so callers keep refusing those instead.
  const npm = (entry.npm ?? '').toLowerCase();
  if (npm.includes('amazon-bedrock') || npm.includes('cohere')) return undefined;
  return 'openai';
}

/**
 * True when the wire comes from the blanket `'openai'` fallback rather than
 * an explicit `type` or a recognized `npm`/`id` — callers should tell the
 * user the protocol was guessed (and may need a manual `base_url`).
 */
export function isGuessedWireType(entry: CatalogProviderEntry): boolean {
  return inferDeclaredWireType(entry) === undefined && inferWireType(entry) !== undefined;
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

/**
 * Resolves the base URL to store for a catalog provider, adapting the catalog's
 * `api` to the wire's SDK convention.
 *
 * models.dev `api` URLs are written for the SDK named in `npm` (e.g.
 * `@ai-sdk/anthropic`), whose base already includes the `/v1` version segment.
 * We route the `anthropic` wire through the official `@anthropic-ai/sdk`, which
 * appends `/v1/messages` itself — so a catalog `api` ending in `/v1` would POST
 * to `/v1/v1/messages` (404). Strip the trailing `/v1` for anthropic. OpenAI
 * family SDKs append `/chat/completions` to a `/v1` base, so those pass through.
 * URLs containing `${VAR}` are SDK-side env interpolations the config cannot
 * express; they resolve to `undefined` so callers can ask for a URL instead.
 */
export function catalogBaseUrl(
  entry: CatalogProviderEntry,
  wire: ProviderType,
): string | undefined {
  const api = entry.api;
  if (typeof api !== 'string' || api.length === 0 || api.includes('${')) return undefined;
  return adaptBaseUrlForWire(api, wire);
}

/**
 * Adapts a base URL to the wire's SDK convention: the Anthropic SDK appends
 * `/v1/messages` itself, so a trailing `/v1` is stripped (otherwise requests
 * land on `/v1/v1/messages`); other wires pass through unchanged. Applied to
 * catalog-declared and user-supplied URLs alike.
 */
export function adaptBaseUrlForWire(baseUrl: string, wire: ProviderType): string {
  return wire === 'anthropic' ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl;
}

/**
 * True when importing this provider needs a base URL from the user: the
 * catalog supplies none (or only an env placeholder), and the wire's built-in
 * default endpoint only applies to the vendor's official SDK package — for
 * every other npm it would silently point at the wrong host (e.g. an xai key
 * sent to api.openai.com, or a gateway's Anthropic-compatible key sent to
 * api.anthropic.com). Vertex/google wires resolve their endpoint from env
 * coordinates and official SDKs, so they never need the prompt.
 */
export function catalogProviderNeedsBaseUrl(
  entry: CatalogProviderEntry,
  wire: ProviderType,
): boolean {
  if (catalogBaseUrl(entry, wire) !== undefined) return false;
  const npm = (entry.npm ?? '').toLowerCase();
  if (wire === 'openai' || wire === 'openai_responses') return npm !== '@ai-sdk/openai';
  if (wire === 'anthropic') return npm !== '@ai-sdk/anthropic';
  return false;
}

/** Normalizes one catalog model entry into a {@link CatalogModel}; skips invalid entries. */
export function catalogModelToCapability(model: CatalogModelEntry): CatalogModel | undefined {
  if (typeof model.id !== 'string' || model.id.length === 0) return undefined;
  const context = model.limit?.context;
  if (typeof context !== 'number' || !Number.isInteger(context) || context <= 0) return undefined;
  if (!isUsableChatModel(model)) return undefined;
  const inputs = model.modalities?.input ?? [];
  const output = model.limit?.output;
  const thinking = catalogThinkingOptions(model.reasoning_options);
  // `limit.input` is the true prompt cap when declared (e.g. gpt-5: 400k
  // context window but a 272k input limit); sizing the context budget to the
  // total window would let the prompt overflow before compaction kicks in.
  const input = model.limit?.input;
  const maxContextTokens =
    typeof input === 'number' && Number.isInteger(input) && input > 0
      ? Math.min(input, context)
      : context;
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
      // Declaring concrete effort levels (or a toggle) implies thinking
      // support even when the `reasoning` boolean is absent (mirrors the
      // api.json importer).
      thinking:
        Boolean(model.reasoning) || thinking.efforts !== undefined || thinking.hasToggle,
      tool_use: model.tool_call ?? true,
      max_context_tokens: maxContextTokens,
      dynamically_loaded_tools: model.dynamically_loaded_tools === true,
    },
  };
}

/**
 * Reads a `reasoning_options` list: the `{ type: 'effort', values: [...] }`
 * levels, the `'none'` pseudo-level, and the `{ type: 'toggle' }` boolean
 * form. `'none'` is not a selectable level — it is the wire encoding for
 * disabling thinking (e.g. xai grok) and becomes {@link CatalogModel.offEffort};
 * the UI keeps using its own `off` entry for it. A model that declares levels
 * with neither a toggle nor `'none'` always reasons — it cannot be turned off.
 */
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
    // models.dev writes the disable tier either as the string 'none' or as
    // JSON null (the TOML source spells it "null"); both encode the same
    // wire value (`reasoning_effort: 'none'`).
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
  // Only the object form carries a field name. `interleaved: true` is just
  // "general support": the provider already defaults to scanning
  // `reasoning_content` / `reasoning_details` / `reasoning` inbound and to
  // `reasoning_content` outbound, so pinning a key here would only narrow the
  // inbound scan to one field — strictly worse for gateways that answer with
  // one of the other names.
  if (typeof interleaved !== 'object' || interleaved === null) return undefined;
  const field = interleaved.field?.trim();
  return field !== undefined && field.length > 0 ? field : undefined;
}

/** Extracts the valid, normalized models from a catalog provider entry. */
export function catalogProviderModels(entry: CatalogProviderEntry): CatalogModel[] {
  const providerWire = inferWireType(entry);
  return Object.values(entry.models ?? {})
    .map((raw) => applyModelProviderOverride(catalogModelToCapability(raw), raw, entry, providerWire))
    .filter((model): model is CatalogModel => model !== undefined);
}

/**
 * Gateway providers (zenmux, opencode, azure, …) may declare a per-model
 * `provider` override when a model is served over a different protocol than
 * the provider default. Overrides targeting Anthropic with a usable endpoint
 * are materialized into a per-model protocol + base URL; overrides pointing
 * at a different wire that cannot be materialized cause the model to be
 * skipped — importing it under the provider's wire would be the silently
 * wrong protocol. Overrides matching the provider's wire (or that we cannot
 * identify) leave the model untouched.
 */
function applyModelProviderOverride(
  model: CatalogModel | undefined,
  raw: CatalogModelEntry,
  entry: CatalogProviderEntry,
  providerWire: ProviderType | undefined,
): CatalogModel | undefined {
  if (model === undefined) return undefined;
  const override = raw.provider;
  if (override === undefined || typeof override.npm !== 'string') return model;
  const npm = override.npm.toLowerCase();
  const overrideWire = npm.includes('anthropic')
    ? 'anthropic'
    : npm.includes('openai')
      ? 'openai'
      : undefined;
  // Nothing to express when the override targets the wire the provider
  // already resolves to (or one we cannot identify).
  if (overrideWire === undefined || overrideWire === providerWire) return model;
  // Only Anthropic-direction overrides are materializable (the alias schema
  // cannot express other per-model protocols), and only with a usable
  // endpoint. Anything else would be imported under the provider's wire —
  // the silently wrong protocol — so the model is skipped instead. Examples:
  // freemodel's gpt entries on an Anthropic provider, or Claude models on
  // google-vertex (whose wire here is Gemini-mode Vertex, not
  // Anthropic-over-Vertex).
  if (overrideWire === 'anthropic') {
    const api = override.api ?? entry.api;
    if (typeof api === 'string' && api.length > 0 && !api.includes('${')) {
      return { ...model, protocol: 'anthropic', baseUrl: catalogBaseUrl({ api }, 'anthropic') };
    }
  }
  return undefined;
}
