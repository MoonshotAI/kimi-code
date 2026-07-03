import { readApiErrorMessage } from './api-error';
import { CUSTOM_REGISTRY_MODEL_FIELDS, mergeRefreshedModelAlias } from './model-alias-merge';
import { isRecord } from './utils';
import type { ManagedKimiConfigShape, ManagedKimiModelAlias } from './managed-kimi-code';

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
 */
export async function fetchCustomRegistry(
  source: CustomRegistrySource,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Record<string, CustomRegistryProviderEntry>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
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
  if (model.reasoning === true) caps.add('thinking');
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
    model.modalities !== undefined
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
 */
export function applyCustomRegistryProvider(
  config: ManagedKimiConfigShape,
  entry: CustomRegistryProviderEntry,
  source: CustomRegistrySource,
): void {
  const providerKey = entry.id;

  config.providers[providerKey] = {
    type: entry.type,
    baseUrl: entry.api,
    apiKey: source.apiKey,
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
 * Applies every entry from a single api.json import in memory. Mirrors the
 * "remove if present, then apply" sequence the Add Platform flow used to do
 * via the `removeProvider` RPC, but stays purely in-memory so callers can
 * persist the whole batch with a single write at the end.
 *
 * Bug fixed: previously the caller interleaved in-memory `applyCustomRegistry-
 * Provider` with the disk-writing `removeProvider` RPC inside a loop. Each
 * RPC re-read disk and returned a fresh config object, discarding entries that
 * had already been merged in-memory from earlier iterations. Re-importing a
 * multi-provider api.json silently lost N-1 of N providers.
 *
 * Re-import semantics: providers previously imported from the same source URL
 * but no longer present in `entries` are removed (along with their aliases and
 * any `defaultModel` pointing at them). Without this, deleting a provider
 * upstream and re-importing the registry leaves orphaned provider records and
 * model aliases behind. Matching is by `source.url` only — the apiKey commonly
 * rotates between imports, but the URL is the stable identity of "the same
 * registry".
 */
export function applyCustomRegistryEntries(
  config: ManagedKimiConfigShape,
  entries: Record<string, CustomRegistryProviderEntry>,
  source: CustomRegistrySource,
): void {
  const surviving = new Set(Object.values(entries).map((entry) => entry.id));
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (surviving.has(providerId)) continue;
    if (!isRecord(provider)) continue;
    const existingSource = provider['source'];
    if (
      isRecord(existingSource) &&
      existingSource['kind'] === 'apiJson' &&
      existingSource['url'] === source.url
    ) {
      removeCustomRegistryProvider(config, providerId);
    }
  }

  for (const entry of Object.values(entries)) {
    if (entry.id in config.providers) {
      removeCustomRegistryProvider(config, entry.id);
    }
    applyCustomRegistryProvider(config, entry, source);
  }
}
