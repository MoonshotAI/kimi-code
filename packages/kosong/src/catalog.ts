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

/** Why a catalog import cannot proceed at all. */
export type CatalogImportInvalidReason =
  /** `type` is present but names a protocol this client version does not know. */
  | 'unknown-explicit-type'
  /** SDK known to be non-OpenAI proprietary (Amazon Bedrock, Cohere). */
  | 'proprietary-sdk'
  /** A base URL was supplied but is blank. */
  | 'empty-base-url'
  /** The endpoint contains an env placeholder (`${VAR}`) the config cannot express. */
  | 'placeholder-base-url';

/**
 * The outcome of resolving a catalog provider for import — the single
 * decision point for "which wire, which endpoint, or exactly why not".
 * Pattern-match on {@link CatalogImportResolution.kind}:
 *  - `ok`: persist `wire` (and `baseUrl` when present — absent means the
 *    wire's official-SDK default endpoint applies); surface `guessed` so the
 *    user knows the protocol came from the OpenAI-compatible fallback.
 *  - `needs-base-url`: the catalog supplies no usable endpoint and the
 *    wire's default would point at the wrong host — ask the user for one
 *    (`--base-url` on the CLI, a prompt in the TUI), then re-resolve with it.
 *  - `invalid`: refuse with the reason.
 */
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
 * Resolves a catalog provider entry into an import decision.
 *
 * Wire: an explicit `type` is authoritative (honored when known, refused
 * when not); otherwise `npm`/`id` heuristics; otherwise the
 * OpenAI-compatible fallback (`guessed: true`) — except SDKs known to be
 * non-OpenAI proprietary, which are refused outright.
 *
 * Endpoint: a user-supplied URL wins over the catalog's `api` (after trim;
 * blank and `${VAR}` placeholders are rejected). Without one, the catalog
 * `api` applies; with neither, only wires whose default endpoint belongs to
 * the vendor's official SDK (`@ai-sdk/openai`, `@ai-sdk/anthropic`, or
 * env-resolved vertex/google) resolve without asking — everything else is
 * `needs-base-url`, because persisting no endpoint would silently send the
 * key to the wrong host. URLs are adapted to the wire's SDK convention
 * (trailing `/v1` stripped for Anthropic).
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

/**
 * The wire part of {@link resolveCatalogImport}, also used when listing
 * models (where import eligibility is not the question). `undefined` means
 * the entry is not importable: an explicit type this client does not know,
 * or a proprietary non-OpenAI SDK (Bedrock, Cohere).
 */
function resolveCatalogWire(entry: CatalogProviderEntry): ProviderType | undefined {
  if (isWireType(entry.type)) return entry.type;
  if (typeof entry.type === 'string' && entry.type.length > 0) return undefined;
  const declared = inferDeclaredWireType(entry);
  if (declared !== undefined) return declared;
  const npm = (entry.npm ?? '').toLowerCase();
  if (npm.includes('amazon-bedrock') || npm.includes('cohere')) return undefined;
  return 'openai';
}

/**
 * @deprecated Use {@link resolveCatalogImport}. This compatibility wrapper
 * answers only the wire (`undefined` when the entry is not importable) and
 * is kept until the next major release for downstream consumers of the
 * previous public API.
 */
export function inferWireType(entry: CatalogProviderEntry): ProviderType | undefined {
  return resolveCatalogWire(entry);
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
 * True when a missing catalog endpoint cannot fall back to a built-in
 * default: an explicitly declared endpoint the config cannot express (an
 * env placeholder) always requires asking — silently defaulting would send
 * the credential to the public vendor host instead of the declared one.
 * Without any declaration, the wire's default endpoint only belongs to the
 * vendor's official SDK package — for every other npm it would silently
 * point at the wrong host (e.g. an xai key sent to api.openai.com, or a
 * gateway's Anthropic-compatible key sent to api.anthropic.com).
 * Vertex/google wires resolve their endpoint from env coordinates and
 * official SDKs, so they never need the prompt.
 */
function catalogEndpointRequired(entry: CatalogProviderEntry, wire: ProviderType): boolean {
  if (typeof entry.api === 'string' && entry.api.length > 0) return true;
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
  // context window but a 272k input limit); it is tracked separately from the
  // total window so prompt-budget checks (compaction) use the cap while
  // completion budgeting keeps the full window.
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
      // Declaring concrete effort levels (or a toggle) implies thinking
      // support even when the `reasoning` boolean is absent (mirrors the
      // api.json importer).
      thinking:
        Boolean(model.reasoning) || thinking.efforts !== undefined || thinking.hasToggle,
      tool_use: model.tool_call ?? true,
      max_context_tokens: context,
      max_input_tokens: maxInputTokens,
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
  const providerWire = resolveCatalogWire(entry);
  return Object.values(entry.models ?? {})
    .map((raw) => applyModelProviderOverride(catalogModelToCapability(raw), raw, entry, providerWire))
    .filter((model): model is CatalogModel => model !== undefined)
    .map((model) => {
      // The always-thinking inference ("effort levels, no toggle, no 'none'
      // — reasoning cannot be turned off") must not fire where the wire has
      // a true protocol-level disable the effort list can never show:
      // Anthropic and Kimi both encode off as `thinking: {type: 'disabled'}`,
      // so marking those models always-on would hide a working off. On every
      // other wire the same catalog shape is exactly the evidence the marker
      // exists for — gpt-5-class models reject `reasoning_effort: 'none'`,
      // and Gemini 3's floor is `thinkingLevel: 'MINIMAL'` (still reasoning,
      // merely with thoughts hidden) — so there the marker keeps the UI from
      // offering an off that does not exist.
      const protocol = model.protocol ?? providerWire;
      if (
        model.alwaysThinking === true &&
        (protocol === 'anthropic' || protocol === 'kimi')
      ) {
        const { alwaysThinking: _dropped, ...rest } = model;
        return rest as CatalogModel;
      }
      return model;
    });
}

/**
 * Gateway providers (zenmux, opencode, azure, …) may declare a per-model
 * `provider` override when a model is served over a different protocol or
 * endpoint than the provider default. Overrides targeting Anthropic with a
 * usable endpoint are materialized into a per-model protocol + base URL;
 * overrides pointing at a different wire that cannot be materialized cause
 * the model to be skipped — importing it under the provider's wire would be
 * the silently wrong protocol. Overrides on the provider's own wire keep the
 * model but still carry their own endpoint when it differs from the
 * provider's.
 */
function applyModelProviderOverride(
  model: CatalogModel | undefined,
  raw: CatalogModelEntry,
  entry: CatalogProviderEntry,
  providerWire: ProviderType | undefined,
): CatalogModel | undefined {
  if (model === undefined) return undefined;
  const override = raw.provider;
  if (override === undefined) return model;
  // An api-only override keeps the provider's wire; an npm override points at
  // a (possibly different) one. Known proprietary SDKs are refused like at
  // top level; other unrecognized npm gets the same OpenAI-compatible
  // fallback so a concretely declared endpoint is not silently dropped.
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
    // An explicitly declared endpoint the config cannot express (env
    // placeholder): the model belongs elsewhere we cannot persist or prompt
    // for — skip it rather than silently reroute to the provider endpoint.
    if (typeof rawApi === 'string' && rawApi.includes('${')) return undefined;
    // A distinct usable endpoint applies to this model specifically.
    if (usableApi !== undefined && usableApi !== entry.api) {
      return { ...model, baseUrl: adaptBaseUrlForWire(usableApi, overrideWire) };
    }
    return model;
  }

  // Only Anthropic-direction overrides are materializable (the alias schema
  // cannot express other per-model protocols), and only with a usable
  // endpoint. Anything else would be imported under the provider's wire —
  // the silently wrong protocol — so the model is skipped instead. Examples:
  // freemodel's gpt entries on an Anthropic provider, Claude models on
  // google-vertex (whose wire here is Gemini-mode Vertex), or a google-genai
  // override on an OpenAI gateway.
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
