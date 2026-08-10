/**
 * Local custom-registry provider import — ported (trimmed) from
 * `@moonshot-ai/kimi-code-oauth` `custom-registry.ts` + its dependencies
 * (`api-error.ts`, `model-alias-merge.ts`, `redact.ts`, `utils.ts`, and the
 * `managed-kimi-code.ts` config shapes) for the `kimi provider add` subcommand
 * (G-3 CLI consumption cutover: the oauth package retires, the TS host keeps
 * the registry import until the host itself retires).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Managed config shapes (minimal, from managed-kimi-code.ts) ──────────────

export interface ManagedKimiModelAliasOverrides {
  maxContextSize?: number | undefined;
  maxOutputSize?: number | undefined;
  capabilities?: string[] | undefined;
  displayName?: string | undefined;
  reasoningKey?: string | undefined;
  adaptiveThinking?: boolean | undefined;
  supportEfforts?: readonly string[] | undefined;
  defaultEffort?: string | undefined;
  readonly [key: string]: unknown;
}

export interface ManagedKimiModelAlias {
  provider: string;
  model: string;
  maxContextSize: number;
  capabilities?: string[] | undefined;
  supportEfforts?: readonly string[] | undefined;
  defaultEffort?: string | undefined;
  displayName?: string | undefined;
  adaptiveThinking?: boolean | undefined;
  overrides?: ManagedKimiModelAliasOverrides | undefined;
  readonly [key: string]: unknown;
}

/** The config surface `applyCustomRegistryProvider` mutates in place. */
export interface ManagedKimiConfigShape {
  providers: Record<string, Record<string, unknown>>;
  models?: Record<string, ManagedKimiModelAlias | Record<string, unknown>> | undefined;
  defaultModel?: string | undefined;
  [key: string]: unknown;
}

// ── Error redaction (from redact.ts) ────────────────────────────────────────

const REDACTED = '[REDACTED]';

const RAW_SECRET_PATTERNS: readonly RegExp[] = [
  // Bearer tokens in Authorization headers
  /\b(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/gi,
  // Key-value pairs for api keys, tokens, secrets, passwords
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret)\s*[:=]\s*)[^\s"'`]+/gi,
  // Cookie values
  /\b(cookie\s*[:=]\s*)[^\r\n]+/gi,
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of RAW_SECRET_PATTERNS) {
    out = out.replace(pattern, `$1${REDACTED}`);
  }
  return out;
}

// ── API error extraction (from api-error.ts) ────────────────────────────────

const DIRECT_ERROR_KEYS = ['error_description', 'message', 'detail'] as const;
const NESTED_ERROR_KEYS = ['message', 'error_description', 'detail', 'code', 'type'] as const;

function extractApiErrorMessage(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractApiErrorMessage(item);
      if (message !== undefined) return message;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  for (const key of DIRECT_ERROR_KEYS) {
    const message = stringField(value, key);
    if (message !== undefined) return message;
  }

  const error = value['error'];
  const errorString = nonEmptyString(error);
  if (errorString !== undefined) return errorString;

  if (isRecord(error)) {
    for (const key of NESTED_ERROR_KEYS) {
      const message = stringField(error, key);
      if (message !== undefined) return message;
    }
  }

  const errors = value['errors'];
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const message = extractApiErrorMessage(item);
      if (message !== undefined) return message;
    }
  }

  return undefined;
}

async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return fallback;
  }

  const raw = extractApiErrorMessage(parsed) ?? fallback;
  // Defensively redact any tokens or secrets the upstream server may have
  // inadvertently included in its error response body.
  return redactString(raw);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return nonEmptyString(record[key]);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Model alias merge (from model-alias-merge.ts) ───────────────────────────

const CUSTOM_REGISTRY_MODEL_FIELDS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'maxContextSize',
  'capabilities',
  'displayName',
  'supportEfforts',
  'defaultEffort',
]);

function cloneOverrides(
  overrides: ManagedKimiModelAliasOverrides | undefined,
): ManagedKimiModelAliasOverrides | undefined {
  if (overrides === undefined) return undefined;
  return structuredClone(overrides);
}

function userExtras(
  existing: Record<string, unknown>,
  remoteOwnedFields: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (key === 'overrides') continue;
    if (!remoteOwnedFields.has(key)) out[key] = value;
  }
  return out;
}

function mergeRefreshedModelAlias(
  existing: unknown,
  remote: ManagedKimiModelAlias,
  remoteOwnedFields: ReadonlySet<string>,
): ManagedKimiModelAlias {
  const current = isRecord(existing) ? existing : {};
  const overrides = cloneOverrides(
    isRecord(current['overrides'])
      ? (current['overrides'] as ManagedKimiModelAliasOverrides)
      : undefined,
  );
  return {
    ...userExtras(current, remoteOwnedFields),
    ...remote,
    ...(overrides !== undefined ? { overrides } : {}),
  };
}

// ── Custom registry (from custom-registry.ts) ───────────────────────────────

/** Identifies where a custom-registry-managed provider came from. */
export interface CustomRegistrySource {
  readonly kind: 'apiJson';
  readonly url: string;
  readonly apiKey: string;
}

export interface FetchCustomRegistryOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

/**
 * The kosong `ProviderConfig` union mirrors these literal values. `kimi` is
 * included because the api.json schema permits it.
 */
export type CustomRegistryProviderType = 'anthropic' | 'openai' | 'openai_responses' | 'kimi';

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

export class CustomRegistryApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CustomRegistryApiError';
    this.status = status;
  }
}

const CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT = 131072;
const CUSTOM_REGISTRY_DEFAULT_CAPABILITIES = ['tool_use'] as const;

const ALLOWED_PROVIDER_TYPES: ReadonlySet<CustomRegistryProviderType> = new Set([
  'anthropic',
  'openai',
  'openai_responses',
  'kimi',
]);

function isAllowedProviderType(value: unknown): value is CustomRegistryProviderType {
  return (
    typeof value === 'string' && ALLOWED_PROVIDER_TYPES.has(value as CustomRegistryProviderType)
  );
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
 * the top-level provider key in the document; callers iterate `Object.values`
 * to apply each entry.
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
      console.warn(
        `[custom-registry] Skipping invalid entry "${key}" at ${source.url}: missing required fields or unsupported type (id, name, api, type, models).`,
      );
      continue;
    }
    out[key] = entry;
  }

  return out;
}

function capabilitiesFromCustomEntry(model: CustomRegistryModelEntry): string[] {
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
 * Writes one custom-registry provider entry into the managed config in place:
 * provider goes to `config.providers` keyed by `entry.id`, each model becomes
 * an alias under `config.models[\`${entry.id}/${modelId}\`]`, and the `source`
 * blob is parked on the provider object for later refresh rediscovery.
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
  // the user added by hand survive a refresh. Models upstream no longer lists
  // are removed; the rest are merged field-by-field.
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
      ...(model.support_efforts !== undefined ? { supportEfforts: model.support_efforts } : {}),
      ...(model.default_effort !== undefined ? { defaultEffort: model.default_effort } : {}),
    };
    existingModels[aliasKey] = mergeRefreshedModelAlias(
      existing,
      remoteAlias,
      CUSTOM_REGISTRY_MODEL_FIELDS,
    );
  }

  config.models = existingModels;
}
