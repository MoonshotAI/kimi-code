import { readApiErrorMessage } from './api-error';
import {
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  type ManagedKimiConfigShape,
  type ManagedKimiModelAlias,
} from './managed-kimi-code';
import { CUSTOM_REGISTRY_MODEL_FIELDS, mergeRefreshedModelAlias } from './model-alias-merge';
import { OPEN_PLATFORMS } from './open-platform';
import { nonEmptyString } from './provider-credential';
import { isRecord } from './utils';

export type { ManagedKimiConfigShape };

/**
 * Identifies where a custom-registry-managed provider came from. The same
 * URL may produce multiple providers (one per top-level entry in the api.json
 * document). Refresh treats the URL as the stable registry identity and may try
 * more than one API key when existing provider records drift during key
 * rotation.
 */
export interface CustomRegistrySource {
  readonly kind: 'apiJson';
  readonly url: string;
  readonly apiKey: string;
}

/**
 * Parses the `source` blob parked on a provider record back into a
 * {@link CustomRegistrySource}, returning undefined when the record did not
 * come from a custom registry (manual providers, managed login, other kinds).
 * Used both to rediscover refresh candidates and to check whether a provider
 * is owned by a given registry URL.
 */
function customRegistrySourceUrl(provider: unknown): string | undefined {
  if (!isRecord(provider)) return undefined;
  const candidate = provider['source'];
  if (!isRecord(candidate) || candidate['kind'] !== 'apiJson') return undefined;
  const url = candidate['url'];
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

export function readCustomRegistrySource(provider: unknown): CustomRegistrySource | undefined {
  if (!isRecord(provider)) return undefined;
  const candidate = provider['source'];
  const url = customRegistrySourceUrl(provider);
  const apiKey = isRecord(candidate) ? candidate['apiKey'] : undefined;
  if (url === undefined || typeof apiKey !== 'string') return undefined;
  return { kind: 'apiJson', url, apiKey };
}

export interface FetchCustomRegistryOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

/**
 * The kosong `ProviderConfig` union (`packages/kosong/src/providers/index.ts`)
 * mirrors these literal values. `kimi` is included because the api.json schema
 * permits it even though kokub itself only emits the other three.
 */
export type CustomRegistryProviderType =
  | 'anthropic'
  | 'openai'
  | 'openai_responses'
  | 'kimi';

export interface CustomRegistryModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly limit?: { context?: number; output?: number };
  readonly tool_call?: boolean;
  readonly reasoning?: boolean;
  readonly modalities?: {
    input?: readonly string[];
    output?: readonly string[];
  };
  readonly support_efforts?: readonly string[];
  readonly default_effort?: string;
}

export interface CustomRegistryProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly type: CustomRegistryProviderType;
  readonly env?: readonly string[];
  readonly models: Record<string, CustomRegistryModelEntry>;
}

/**
 * Tuned slightly below typical real values so the local compactor kicks in
 * before the upstream rejects with a context-overflow 4xx. Users can override
 * by editing `~/.kimi-code/config.toml`.
 */
export const CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT = 131072;
export const CUSTOM_REGISTRY_DEFAULT_CAPABILITIES = ['tool_use'] as const;

const ALLOWED_PROVIDER_TYPES: ReadonlySet<CustomRegistryProviderType> = new Set([
  'anthropic',
  'openai',
  'openai_responses',
  'kimi',
]);

const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  ...OPEN_PLATFORMS.map((platform) => platform.id),
]);

/**
 * Provider ids a custom registry may never claim: the managed Kimi Code slots
 * and the first-party open platforms. Shared by the import-time guard and the
 * refresh orchestrator so the rejection rule — and its message — lives in one
 * place.
 */
export function isReservedProviderId(providerId: string): boolean {
  return RESERVED_PROVIDER_IDS.has(providerId);
}

export function reservedProviderIdMessage(providerId: string): string {
  return `Custom registry provider id "${providerId}" is reserved by Kimi Code.`;
}

export function oauthManagedProviderMessage(providerId: string): string {
  return `Custom registry provider "${providerId}" is managed by OAuth; log out before importing it.`;
}

function assertCustomRegistryProviderId(providerId: string): void {
  if (isReservedProviderId(providerId)) {
    throw new Error(reservedProviderIdMessage(providerId));
  }
}

function normalizedEndpoint(value: unknown): string | undefined {
  return nonEmptyString(value)?.replace(/\/+$/, '');
}

export class CustomRegistryApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CustomRegistryApiError';
    this.status = status;
  }
}

function isAllowedProviderType(value: unknown): value is CustomRegistryProviderType {
  return typeof value === 'string' && ALLOWED_PROVIDER_TYPES.has(value as CustomRegistryProviderType);
}

function toStringArrayOrUndefined(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    out.push(item);
  }
  return out;
}

function toModelEntry(value: unknown): CustomRegistryModelEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  if (typeof id !== 'string' || id.length === 0) return undefined;

  const entry: {
    id: string;
    name?: string;
    limit?: { context?: number; output?: number };
    tool_call?: boolean;
    reasoning?: boolean;
    modalities?: { input?: readonly string[]; output?: readonly string[] };
    support_efforts?: readonly string[];
    default_effort?: string;
  } = { id };

  const name = value['name'];
  if (typeof name === 'string' && name.length > 0) entry.name = name;

  const limit = value['limit'];
  if (isRecord(limit)) {
    const context = limit['context'];
    const output = limit['output'];
    const parsedLimit: { context?: number; output?: number } = {};
    if (typeof context === 'number' && Number.isFinite(context) && context > 0) {
      parsedLimit.context = Math.floor(context);
    }
    if (typeof output === 'number' && Number.isFinite(output) && output > 0) {
      parsedLimit.output = Math.floor(output);
    }
    if (parsedLimit.context !== undefined || parsedLimit.output !== undefined) {
      entry.limit = parsedLimit;
    }
  }

  if (typeof value['tool_call'] === 'boolean') entry.tool_call = value['tool_call'];
  if (typeof value['reasoning'] === 'boolean') entry.reasoning = value['reasoning'];

  const supportEfforts = toStringArrayOrUndefined(value['support_efforts']);
  if (supportEfforts !== undefined) entry.support_efforts = supportEfforts;
  const defaultEffort = value['default_effort'];
  if (typeof defaultEffort === 'string' && defaultEffort.length > 0) {
    entry.default_effort = defaultEffort;
  }

  const modalities = value['modalities'];
  if (isRecord(modalities)) {
    const input = toStringArrayOrUndefined(modalities['input']);
    const output = toStringArrayOrUndefined(modalities['output']);
    if (input !== undefined || output !== undefined) {
      entry.modalities = {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
      };
    }
  }

  return entry;
}

function toProviderEntry(value: unknown): CustomRegistryProviderEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  const name = value['name'];
  const api = value['api'];
  const type = value['type'];
  const models = value['models'];

  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  if (typeof api !== 'string' || api.length === 0) return undefined;
  if (!isAllowedProviderType(type)) return undefined;
  if (!isRecord(models)) return undefined;

  const parsedModels: Record<string, CustomRegistryModelEntry> = {};
  for (const [key, raw] of Object.entries(models)) {
    const modelEntry = toModelEntry(raw);
    if (modelEntry === undefined) continue;
    parsedModels[key] = modelEntry;
  }

  const env = toStringArrayOrUndefined(value['env']);

  return {
    id,
    name,
    api,
    type,
    ...(env !== undefined ? { env } : {}),
    models: parsedModels,
  };
}

/**
 * Fetches and validates an api.json document. The returned record is keyed by
 * the top-level provider key in the document (which may differ from
 * `entry.id`); callers should iterate `Object.values` to apply each entry.
 *
 * `userAgent` identifies the host product (e.g. `kimi-code-cli/1.2.3`); when
 * omitted the request falls back to the runtime default (`User-Agent: node`).
 */
export async function fetchCustomRegistry(
  source: CustomRegistrySource,
  options: FetchCustomRegistryOptions = {},
): Promise<Record<string, CustomRegistryProviderEntry>> {
  const { signal, fetchImpl = fetch, userAgent } = options;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (userAgent !== undefined) {
    headers['User-Agent'] = userAgent;
  }
  if (source.apiKey.length > 0) {
    headers['Authorization'] = `Bearer ${source.apiKey}`;
  }

  const init: RequestInit = { headers };
  if (signal !== undefined) init.signal = signal;

  const response = await fetchImpl(source.url, init);
  if (!response.ok) {
    const message = await readApiErrorMessage(
      response,
      `Failed to fetch custom registry at ${source.url} (HTTP ${response.status}).`,
    );
    throw new CustomRegistryApiError(message, response.status);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error(
      `Unexpected custom registry response at ${source.url}: expected a JSON object keyed by provider id.`,
    );
  }

  const out: Record<string, CustomRegistryProviderEntry> = {};
  for (const [key, raw] of Object.entries(payload)) {
    const entry = toProviderEntry(raw);
    if (entry === undefined) {
      // Skip invalid/unknown provider entries instead of aborting the whole
      // fetch, mirroring `toModelEntry`'s skip-on-invalid behavior. This keeps
      // existing providers working when kokub adds a new provider type that
      // this client doesn't yet recognize.
      console.warn(
        `[custom-registry] Skipping invalid entry "${key}" at ${source.url}: missing required fields or unsupported type (id, name, api, type, models).`,
      );
      continue;
    }
    out[key] = entry;
  }

  return out;
}

/**
 * Derives kosong capability strings from the rich (optional) fields on a
 * custom-registry model entry. Returns an empty array when none of the rich
 * fields are present; callers are responsible for substituting the default
 * (`CUSTOM_REGISTRY_DEFAULT_CAPABILITIES`) when this returns `[]`.
 */
export function capabilitiesFromCustomEntry(model: CustomRegistryModelEntry): string[] {
  const caps = new Set<string>();
  if (model.tool_call === true) caps.add('tool_use');
  // Declaring concrete effort levels implies thinking support even when the
  // legacy `reasoning` boolean is absent.
  if (model.reasoning === true || (model.support_efforts?.length ?? 0) > 0) {
    caps.add('thinking');
  }
  if (model.modalities?.input?.includes('image') === true) caps.add('image_in');
  if (model.modalities?.input?.includes('video') === true) caps.add('video_in');
  if (model.modalities?.output?.includes('image') === true) caps.add('image_out');
  if (model.modalities?.output?.includes('audio') === true) caps.add('audio_out');
  return [...caps];
}

function hasRichCapabilityHints(model: CustomRegistryModelEntry): boolean {
  return (
    typeof model.tool_call === 'boolean' ||
    typeof model.reasoning === 'boolean' ||
    model.modalities !== undefined ||
    model.support_efforts !== undefined
  );
}

function resolveMaxContextSize(model: CustomRegistryModelEntry): number {
  const context = model.limit?.context;
  const output = model.limit?.output;
  if (typeof context === 'number' && Number.isInteger(context) && context > 0) {
    return context;
  }
  if (typeof output === 'number' && Number.isInteger(output) && output > 0) {
    return output;
  }
  return CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT;
}

function resolveCapabilities(model: CustomRegistryModelEntry): string[] {
  if (hasRichCapabilityHints(model)) {
    return capabilitiesFromCustomEntry(model);
  }
  return [...CUSTOM_REGISTRY_DEFAULT_CAPABILITIES];
}

/**
 * Writes one custom-registry provider entry into the managed config in place.
 * Mirrors `applyOpenPlatformConfig`'s shape: provider goes to `config.providers`
 * keyed by `entry.id`, each model in `entry.models` becomes an alias under
 * `config.models[\`${entry.id}/${modelId}\`]`. The `source` blob is parked on the
 * provider object via `ManagedKimiProviderConfig`'s index signature so the
 * refresh dispatcher can rediscover it later.
 *
 * The entry's `env` field is deliberately NOT consumed here: the registry
 * controls both the variable name and the endpoint the credential is sent to,
 * so the binding is left for the user to declare explicitly. A hand-edited
 * `apiKeyEnv` on the existing record is preserved instead, without
 * resurrecting an inline `apiKey` that would conflict with it — but only when
 * the existing record belongs to the same registry and its endpoint is
 * unchanged. Reserved ids and endpoint changes are rejected before mutation so
 * a registry cannot redirect the environment-backed credential.
 */
function retainedApiKeyEnv(
  existing: unknown,
  entry: CustomRegistryProviderEntry,
  source: CustomRegistrySource,
): string | undefined {
  assertCustomRegistryProviderId(entry.id);
  if (isRecord(existing) && existing['oauth'] !== undefined) {
    throw new Error(oauthManagedProviderMessage(entry.id));
  }
  if (!isRecord(existing) || readCustomRegistrySource(existing)?.url !== source.url) {
    return undefined;
  }
  const apiKeyEnv = nonEmptyString(existing['apiKeyEnv']);
  if (
    apiKeyEnv !== undefined &&
    normalizedEndpoint(existing['baseUrl']) !== normalizedEndpoint(entry.api)
  ) {
    throw new Error(
      `Custom registry provider "${entry.id}" changed endpoint while api_key_env is configured. Remove api_key_env, re-import the registry, verify the new endpoint, then restore api_key_env.`,
    );
  }
  return apiKeyEnv;
}

export function applyCustomRegistryProvider(
  config: ManagedKimiConfigShape,
  entry: CustomRegistryProviderEntry,
  source: CustomRegistrySource,
  priorProviders?: Readonly<Record<string, unknown>>,
): void {
  const providerKey = entry.id;
  const existing = priorProviders?.[providerKey] ?? config.providers[providerKey];
  const existingApiKeyEnv = retainedApiKeyEnv(existing, entry, source);
  config.providers[providerKey] =
    existingApiKeyEnv === undefined
      ? {
          type: entry.type,
          baseUrl: entry.api,
          apiKey: source.apiKey,
          source,
        }
      : {
          type: entry.type,
          baseUrl: entry.api,
          apiKeyEnv: existingApiKeyEnv,
          source,
        };

  const existingModels = config.models ?? {};
  // Selectively merge upstream models into the existing config so any fields
  // the user added by hand (or that upstream does not declare) survive a
  // refresh. Models that upstream no longer lists are removed; the rest are
  // merged field-by-field.
  const upstreamKeys = new Set(
    Object.keys(entry.models).map((modelKey) => `${providerKey}/${modelKey}`),
  );
  for (const [key, alias] of Object.entries(existingModels)) {
    if (isRecord(alias) && alias['provider'] === providerKey && !upstreamKeys.has(key)) {
      delete existingModels[key];
    }
  }

  for (const [modelKey, model] of Object.entries(entry.models)) {
    const aliasKey = `${providerKey}/${modelKey}`;
    const maxContextSize = resolveMaxContextSize(model);
    const capabilities = resolveCapabilities(model);
    const displayName =
      typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id;
    const existing = isRecord(existingModels[aliasKey]) ? existingModels[aliasKey] : {};

    const remoteAlias: ManagedKimiModelAlias = {
      provider: providerKey,
      model: model.id,
      maxContextSize,
      capabilities,
      displayName,
      supportEfforts: model.support_efforts,
      defaultEffort: model.default_effort,
    };
    existingModels[aliasKey] = mergeRefreshedModelAlias(
      existing,
      remoteAlias,
      CUSTOM_REGISTRY_MODEL_FIELDS,
    );
  }

  config.models = existingModels;
}

/**
 * Removes a custom-registry provider and every model alias that referenced it.
 * Clears `defaultModel` if it pointed at a removed alias. Mirrors
 * `removeOpenPlatformConfig`.
 */
export function removeCustomRegistryProvider(
  config: ManagedKimiConfigShape,
  providerId: string,
): void {
  delete config.providers[providerId];

  let removedDefault = false;
  const existingModels = config.models ?? {};
  for (const [key, alias] of Object.entries(existingModels)) {
    if (!isRecord(alias) || alias['provider'] !== providerId) continue;
    delete existingModels[key];
    if (config.defaultModel === key) removedDefault = true;
  }
  config.models = existingModels;

  if (removedDefault) {
    config.defaultModel = undefined;
  }

  if (config['defaultProvider'] === providerId) {
    config['defaultProvider'] = undefined;
  }
}

/**
 * Surfaces the credential env var each entry declares via its `env` field, as
 * `{ [entry.id]: varName }` — a hint only. The binding is never applied
 * automatically: the registry controls both the variable name and the endpoint
 * the credential is sent to, so the user must opt in by setting `api_key_env`
 * in config.toml.
 */
export function credentialEnvHints(
  entries: readonly CustomRegistryProviderEntry[],
): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const entry of entries) {
    for (const value of entry.env ?? []) {
      const envName = nonEmptyString(value);
      if (envName !== undefined) {
        hints[entry.id] = envName;
        break;
      }
    }
  }
  return hints;
}

export interface CustomRegistryRemoval {
  readonly prior: Readonly<Record<string, unknown>>;
  readonly previousDefault: string | undefined;
  readonly previousDefaultProvider: string | undefined;
}

/**
 * Removes the providers a re-import of `source.url` will replace: entries that
 * vanished upstream (same-registry only — a colliding manual or other-registry
 * provider is left alone) plus every entry's current record, so the follow-up
 * apply rebuilds them fresh and state upstream no longer declares cannot
 * linger. The returned snapshot is captured BEFORE anything is removed — pass
 * it to `applyCustomRegistryEntries` so its provenance check can preserve
 * hand-edited `apiKeyEnv` declarations and its defaults restore still sees the
 * pre-removal `defaultModel`/`defaultProvider`.
 */
export function removeCustomRegistryEntries(
  config: ManagedKimiConfigShape,
  entries: Record<string, CustomRegistryProviderEntry>,
  source: CustomRegistrySource,
): CustomRegistryRemoval {
  const surviving = new Set(Object.values(entries).map((entry) => entry.id));
  const removal: CustomRegistryRemoval = {
    prior: { ...config.providers },
    previousDefault: config.defaultModel,
    previousDefaultProvider: config['defaultProvider'] as string | undefined,
  };
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider)) continue;
    if (provider['oauth'] !== undefined || isReservedProviderId(providerId)) continue;
    const existingSource = provider['source'];
    const sameRegistry =
      isRecord(existingSource) &&
      existingSource['kind'] === 'apiJson' &&
      existingSource['url'] === source.url;
    if (surviving.has(providerId) || sameRegistry) {
      removeCustomRegistryProvider(config, providerId);
    }
  }
  return removal;
}

export type CustomRegistryReplacementKeys = Readonly<Record<string, readonly string[]>>;

export function customRegistryReplacementKeys(
  config: ManagedKimiConfigShape,
  entries: Record<string, CustomRegistryProviderEntry>,
  source: CustomRegistrySource,
): CustomRegistryReplacementKeys {
  const providerIds = new Set(Object.values(entries).map((entry) => entry.id));
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider)) continue;
    if (provider['oauth'] !== undefined || isReservedProviderId(providerId)) continue;
    if (customRegistrySourceUrl(provider) === source.url) providerIds.add(providerId);
  }
  const modelIds = new Set<string>();
  for (const [modelId, model] of Object.entries(config.models ?? {})) {
    if (isRecord(model) && providerIds.has(String(model['provider']))) modelIds.add(modelId);
  }
  for (const entry of Object.values(entries)) {
    for (const modelId of Object.keys(entry.models)) {
      modelIds.add(`${entry.id}/${modelId}`);
    }
  }
  return {
    providers: [...providerIds],
    models: [...modelIds],
    thinking: ['enabled', 'effort', 'keep'],
  };
}

/**
 * Applies every entry from a single api.json import in memory. Pass the
 * snapshot returned by {@link removeCustomRegistryEntries} when a caller has
 * already removed the records in memory; without it, the removals are
 * performed here first.
 *
 * Re-import semantics: providers previously imported from the same source URL
 * but no longer present in `entries` are removed (along with their aliases and
 * any `defaultModel` pointing at them). Without this, deleting a provider
 * upstream and re-importing the registry leaves orphaned provider records and
 * model aliases behind. Matching is by `source.url` only — the apiKey commonly
 * rotates between imports, but the URL is the stable identity of "the same
 * registry".
 *
 * Surviving entries are rebuilt from scratch (their records and aliases are
 * removed first, so state upstream no longer declares does not linger), while
 * `applyCustomRegistryProvider` still sees the pre-removal snapshot — its
 * provenance check is the single mechanism that preserves a hand-edited
 * `apiKeyEnv`. Defaults (`defaultModel`/`defaultProvider`) that still resolve
 * after the rebuild are restored from the snapshot; a `defaultModel` left
 * dangling is cleared (with `thinking`, mirroring the refresh path).
 */
export function applyCustomRegistryEntries(
  config: ManagedKimiConfigShape,
  entries: Record<string, CustomRegistryProviderEntry>,
  source: CustomRegistrySource,
  removal?: CustomRegistryRemoval,
): void {
  const entryList = Object.values(entries);
  const priorProviders = removal?.prior ?? config.providers;
  for (const entry of entryList) {
    retainedApiKeyEnv(priorProviders[entry.id], entry, source);
  }
  const r = removal ?? removeCustomRegistryEntries(config, entries, source);
  for (const entry of entryList) {
    applyCustomRegistryProvider(config, entry, source, r.prior);
  }

  config.defaultModel =
    r.previousDefault !== undefined && config.models?.[r.previousDefault] !== undefined
      ? r.previousDefault
      : undefined;
  config['defaultProvider'] =
    r.previousDefaultProvider !== undefined &&
    config.providers[r.previousDefaultProvider] !== undefined
      ? r.previousDefaultProvider
      : undefined;
  if (r.previousDefault !== undefined && config.defaultModel === undefined) {
    config.thinking = undefined;
  }
}
