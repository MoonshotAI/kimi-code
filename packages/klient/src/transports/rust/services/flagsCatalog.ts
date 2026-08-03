/**
 * G4 — `flagService` + `modelService` + `modelResolver` + `providerService` +
 * `providerDiscovery`. Host-side service group: reads/writes the on-disk
 * `config.toml` directly (smol-toml; the rust engine's config file format is
 * camelCase, which this group follows — the node-sdk reader passes camelCase
 * keys through unchanged) and streams `modelResolver.generate` through
 * `@moonshot-ai/kosong`'s provider adapters. Mirrors
 * `agent-core-v2/app/flag/flagService.ts`, `kosong/model/modelService.ts`,
 * `kosong/provider/providerService.ts`, `kosong/model/catalogService.ts`
 * (enumeration + default pointer) and `app/kosongConfig/discoveryService.ts`.
 *
 * Config write style: the whole file is re-serialized on every write (like
 * node-sdk's `writeConfigFile`), so untouched sections are preserved byte-for-
 * byte as parsed. `modelService`/`providerService` `delete` remove the entry
 * from the section; an emptied section is removed from the file. Broken TOML
 * makes writes fail fast ("cannot change settings while config.toml is
 * invalid") while reads degrade to `{}` so flags still resolve from env.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  KimiOAuthToolkit,
  refreshProviderModels,
  type ManagedKimiConfigShape,
  type ManagedKimiOAuthRef,
  type RefreshProviderHost,
} from '@moonshot-ai/kimi-code-oauth';
import {
  createProvider,
  generate,
  type ChatProvider,
  type GenerateOptions,
  type ProviderConfig,
  type ProviderRequestAuth,
  type StreamedMessagePart,
} from '@moonshot-ai/kosong';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { RPCError } from '../../../core/errors.js';
import { registerService } from '../router.js';
import type { RustCallContext, RustServiceRegistry } from '../types.js';

// ── Wire shapes (mirror contract/global/{flags,models,providers,catalog,providerDiscovery}.ts) ──

type FlagSurface = 'core' | 'tui' | 'both';
type FlagSource = 'master-env' | 'env' | 'config' | 'default';

interface ExperimentalFeatureState {
  id: string;
  title: string;
  description: string;
  surface: FlagSurface;
  env: string;
  defaultEnabled: boolean;
  enabled: boolean;
  source: FlagSource;
  configValue?: boolean;
}

interface FlagDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly env: string;
  readonly default: boolean;
  readonly surface: FlagSurface;
}

/** `[models.<id>]` entry — passthrough (unknown keys survive). */
type ModelRecord = Record<string, unknown> & { readonly provider?: string; readonly providerId?: string };
/** `[providers.<id>]` entry — passthrough. */
type ProviderConfigRecord = Record<string, unknown>;

interface ModelCatalogItem {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
}

interface ProviderCatalogItem {
  id: string;
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
  status: 'connected' | 'error' | 'unconfigured';
  models?: string[];
}

interface SetDefaultModelResponse {
  default_model: string;
  model: ModelCatalogItem;
}

interface RefreshProviderModelsResponse {
  changed: Array<{ provider_id: string; provider_name: string; added: number; removed: number }>;
  unchanged: string[];
  failed: Array<{ provider: string; reason: string }>;
}

// ── Experimental-flag registry (port of agent-core-v2/src/app/flag/*) ──────

/** Master env var: when truthy, every experimental flag is enabled. */
const MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

const TRUE_BOOLEAN_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

/** Same lenient parsing as node-sdk `parseBooleanEnv` / v2 `#/_base/utils/env`. */
function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

/** The experimental flags the engine contributes (agent-core-v2 flag modules). */
const FLAG_REGISTRY: readonly FlagDefinition[] = [
  {
    id: 'fault-injection',
    title: 'Fault injection (LLM request failures)',
    description:
      'Allow arming a one-shot deterministic provider failure (HTTP 413 body-size or image-format rejection) on the next LLM request, for testing the media-degraded / media-stripped recovery projections over a live channel.',
    env: 'KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION',
    default: false,
    surface: 'core',
  },
  {
    id: 'tool-select',
    title: 'Tool select (progressive tool disclosure)',
    description:
      'Keep MCP tool schemas out of the immutable top-level tools[]; the model loads them on demand via the select_tools tool. Only takes effect on models whose capability catalog declares dynamically loaded tools.',
    env: 'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT',
    default: false,
    surface: 'core',
  },
  {
    id: 'persistence_minidb_readmodel',
    title: 'minidb read model',
    description:
      'Use the minidb-backed IQueryStore as a derived read model for session indexing and wire replay.',
    env: 'KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL',
    default: false,
    surface: 'core',
  },
  {
    id: 'secondary-model',
    title: 'Secondary model for subagents',
    description:
      'Let newly spawned subagents use a separately configured secondary model by default, with an explicit primary-model override for quality-sensitive tasks.',
    env: 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL',
    default: false,
    surface: 'core',
  },
];

function flagState(
  def: FlagDefinition,
  enabled: boolean,
  source: FlagSource,
  configValue: boolean | undefined,
): ExperimentalFeatureState {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    surface: def.surface,
    env: def.env,
    defaultEnabled: def.default,
    enabled,
    source,
    configValue,
  };
}

function explainFlag(def: FlagDefinition, configValue: boolean | undefined): ExperimentalFeatureState {
  if (parseBooleanEnv(process.env[MASTER_ENV]) === true) {
    return flagState(def, true, 'master-env', configValue);
  }
  const override = parseBooleanEnv(process.env[def.env]);
  if (override !== undefined) return flagState(def, override, 'env', configValue);
  if (configValue !== undefined) return flagState(def, configValue, 'config', configValue);
  return flagState(def, def.default, 'default', undefined);
}

// ── Config access (host-side read/write of config.toml) ────────────────────

const EMPTY_CONFIG: Record<string, unknown> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/**
 * Per-entry transform for `[models.*]` / `[providers.*]` records (port of
 * node-sdk `transformModelData` / `transformProviderData`): keys are
 * snake_case → camelCase, nested `overrides` / `oauth` are camelized, but
 * `env` / `customHeaders` / `source` bags keep their keys verbatim
 * (`KIMI_API_KEY` is a real env var name, not a config field).
 */
function camelizeModelEntry(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'overrides' || targetKey === 'oauth') {
      out[targetKey] = isRecord(raw) ? camelizeModelEntry(raw) : raw;
    } else {
      out[targetKey] = raw;
    }
  }
  return out;
}

function camelizeProviderEntry(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isRecord(raw) ? camelizeModelEntry(raw) : raw;
    } else {
      out[targetKey] = raw;
    }
  }
  return out;
}

/**
 * Parse the on-disk config into a camelCase view (top-level keys only;
 * section values are transformed by the section-specific readers). Lenient:
 * a missing file yields `{}`; a TOML syntax error yields `{}` on reads (flags
 * must still resolve from env). Write paths use `readConfigForUpdate` instead.
 */
function readConfig(ctx: RustCallContext): Record<string, unknown> {
  try {
    const text = readFileSync(ctx.host.configPath, 'utf-8');
    if (text.trim().length === 0) return EMPTY_CONFIG;
    const parsed = parseToml(text) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[snakeToCamel(key)] = value;
    }
    return out;
  } catch {
    return EMPTY_CONFIG;
  }
}

/** Strict parse for write paths — never rewrite a broken config. */
function readConfigForUpdate(ctx: RustCallContext): Record<string, unknown> {
  try {
    const text = readFileSync(ctx.host.configPath, 'utf-8');
    if (text.trim().length === 0) return {};
    const parsed = parseToml(text) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[snakeToCamel(key)] = value;
    }
    return out;
  } catch (error) {
    throw new Error(
      `Cannot change settings while ${ctx.host.configPath} is invalid — fix it first: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Re-serialize the camelCase view back to TOML (atomic-ish temp + rename). */
function writeConfig(ctx: RustCallContext, data: Record<string, unknown>): void {
  const dir = dirname(ctx.host.configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${ctx.host.configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${stringifyToml(stripUndefined(data))}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, ctx.host.configPath);
}

/** Facade wire objects carry `undefined` fields; TOML has no undefined. */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    out[key] = stripUndefined(raw);
  }
  return out;
}

/** `[models.*]` section as a camelCase record (missing/invalid → `{}`). */
function readModels(ctx: RustCallContext): Record<string, ModelRecord> {
  const section = readConfig(ctx)['models'];
  if (!isRecord(section)) return {};
  const out: Record<string, ModelRecord> = {};
  for (const [modelId, entry] of Object.entries(section)) {
    out[modelId] = (isRecord(entry) ? camelizeModelEntry(entry) : entry) as ModelRecord;
  }
  return out;
}

/** `[providers.*]` section as a camelCase record (missing/invalid → `{}`). */
function readProviders(ctx: RustCallContext): Record<string, ProviderConfigRecord> {
  const section = readConfig(ctx)['providers'];
  if (!isRecord(section)) return {};
  const out: Record<string, ProviderConfigRecord> = {};
  for (const [providerId, entry] of Object.entries(section)) {
    out[providerId] = (isRecord(entry) ? camelizeProviderEntry(entry) : entry) as ProviderConfigRecord;
  }
  return out;
}

function readDefaultModel(ctx: RustCallContext): string | undefined {
  const value = readConfig(ctx)['defaultModel'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `[experimental]` section — flag id → boolean | string override. */
function readExperimental(ctx: RustCallContext): Record<string, unknown> {
  const section = readConfig(ctx)['experimental'];
  return isRecord(section) ? section : {};
}

/** Write one record-keyed section, dropping it when emptied (node-sdk style). */
function setSectionEntry(
  data: Record<string, unknown>,
  section: string,
  id: string,
  value: ModelRecord | ProviderConfigRecord | undefined,
): void {
  if (value === undefined) {
    const current = data[section];
    if (isRecord(current)) {
      delete current[id];
      if (Object.keys(current).length === 0) delete data[section];
    }
    return;
  }
  const current = isRecord(data[section]) ? data[section] : {};
  current[id] = value;
  data[section] = current;
}

// ── modelService — `[models.*]` configuration registry ─────────────────────

export const modelService: RustServiceRegistry = {
  async get(ctx) {
    const modelId = ctx.args[0] as string;
    return readModels(ctx)[modelId];
  },

  async list(ctx) {
    return readModels(ctx);
  },

  async set(ctx) {
    const [modelId, record] = ctx.args as [string, ModelRecord];
    const data = readConfigForUpdate(ctx);
    setSectionEntry(data, 'models', modelId, record);
    writeConfig(ctx, data);
  },

  async delete(ctx) {
    const modelId = ctx.args[0] as string;
    const data = readConfigForUpdate(ctx);
    setSectionEntry(data, 'models', modelId, undefined);
    writeConfig(ctx, data);
  },
};

// ── providerService — `[providers.*]` configuration registry ───────────────

export const providerService: RustServiceRegistry = {
  async get(ctx) {
    const providerId = ctx.args[0] as string;
    return readProviders(ctx)[providerId];
  },

  async set(ctx) {
    const [providerId, config] = ctx.args as [string, ProviderConfigRecord];
    const data = readConfigForUpdate(ctx);
    setSectionEntry(data, 'providers', providerId, config);
    writeConfig(ctx, data);
  },

  async delete(ctx) {
    const providerId = ctx.args[0] as string;
    const data = readConfigForUpdate(ctx);
    setSectionEntry(data, 'providers', providerId, undefined);
    writeConfig(ctx, data);
  },
};

// ── modelResolver — materialized catalog over config + streaming generate ───

const PROVIDER_NOT_FOUND = 40404;
const MODEL_NOT_FOUND = 40404;

/**
 * Credential detection (port of v2 `hasConfiguredApiKey`): the inline
 * `apiKey` wins, otherwise the vendor's declared api-key env var is read from
 * the provider's config `env` bag (never `process.env`).
 */
const VENDOR_API_KEY_ENV: Readonly<Record<string, string>> = {
  kimi: 'KIMI_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai_responses': 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'google-genai': 'GOOGLE_API_KEY',
  vertexai: 'GOOGLE_API_KEY',
};

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hasConfiguredApiKey(provider: ProviderConfigRecord): boolean {
  if (nonEmpty(provider['apiKey']) !== undefined) return true;
  const type = typeof provider['type'] === 'string' ? provider['type'] : undefined;
  if (type === undefined) return false;
  const envKey = VENDOR_API_KEY_ENV[type];
  if (envKey === undefined) return false;
  const env = isRecord(provider['env']) ? provider['env'] : {};
  return nonEmpty(env[envKey]) !== undefined;
}

/** Best-effort cached-token check (mirrors v2 `hasCachedToken`). */
async function hasCachedToken(ctx: RustCallContext, provider: ProviderConfigRecord): Promise<boolean> {
  const oauthRef = provider['oauth'];
  if (!isRecord(oauthRef)) return false;
  try {
    const toolkit = getToolkit(ctx);
    const token = await toolkit.getCachedAccessToken(
      typeof provider['type'] === 'string' ? provider['type'] : 'unknown',
      oauthRef as unknown as ManagedKimiOAuthRef,
    );
    return token !== undefined;
  } catch {
    return false;
  }
}

/** Config-only projection (v2 `toProtocolModelFallback` semantics). */
function projectModel(modelId: string, record: ModelRecord): ModelCatalogItem {
  const displayName = nonEmpty(record['displayName']) ?? nonEmpty(record['model']) ?? modelId;
  return {
    provider: nonEmpty(record['provider']) ?? nonEmpty(record['providerId']) ?? '',
    model: modelId,
    display_name: displayName,
    max_context_size: typeof record['maxContextSize'] === 'number' ? record['maxContextSize'] : 0,
    ...(Array.isArray(record['capabilities']) ? { capabilities: record['capabilities'] as string[] } : {}),
    ...(Array.isArray(record['supportEfforts']) ? { support_efforts: record['supportEfforts'] as string[] } : {}),
    ...(nonEmpty(record['defaultEffort']) !== undefined ? { default_effort: record['defaultEffort'] as string } : {}),
  };
}

function modelIdsForProvider(
  models: Readonly<Record<string, ModelRecord>>,
  providerId: string,
): string[] {
  return Object.entries(models)
    .filter(([, record]) => record['provider'] === providerId || record['providerId'] === providerId)
    .map(([modelId]) => modelId);
}

function globalDefaultForProvider(
  models: Readonly<Record<string, ModelRecord>>,
  globalDefaultModel: string | undefined,
  providerId: string,
): string | undefined {
  if (globalDefaultModel === undefined) return undefined;
  const record = models[globalDefaultModel];
  if (record === undefined) return undefined;
  return record['provider'] === providerId || record['providerId'] === providerId
    ? globalDefaultModel
    : undefined;
}

async function toCatalogProvider(
  ctx: RustCallContext,
  providerId: string,
  provider: ProviderConfigRecord,
  models: Readonly<Record<string, ModelRecord>>,
  globalDefaultModel: string | undefined,
): Promise<ProviderCatalogItem> {
  const apiKey = hasConfiguredApiKey(provider);
  const oauthToken = await hasCachedToken(ctx, provider);
  const connected = apiKey || oauthToken;
  return {
    id: providerId,
    type: nonEmpty(provider['type']) ?? 'openai',
    ...(nonEmpty(provider['baseUrl']) !== undefined ? { base_url: provider['baseUrl'] as string } : {}),
    default_model:
      nonEmpty(provider['defaultModel']) ??
      globalDefaultForProvider(models, globalDefaultModel, providerId),
    has_api_key: apiKey,
    status: connected ? 'connected' : 'unconfigured',
    models: modelIdsForProvider(models, providerId),
  };
}

/** OAuth toolkit over `host.homeDir` (mirrors G3's auth group). */
const defaultToolkits = new Map<string, KimiOAuthToolkit>();

function getToolkit(ctx: RustCallContext): KimiOAuthToolkit {
  const injected = ctx.host.auth as { readonly toolkit?: KimiOAuthToolkit } | undefined;
  if (injected?.toolkit !== undefined) return injected.toolkit;
  let toolkit = defaultToolkits.get(ctx.host.homeDir);
  if (toolkit === undefined) {
    toolkit = new KimiOAuthToolkit({ homeDir: ctx.host.homeDir });
    defaultToolkits.set(ctx.host.homeDir, toolkit);
  }
  return toolkit;
}

export const modelResolver: RustServiceRegistry = {
  async listModels(ctx) {
    const models = readModels(ctx);
    return Object.entries(models).map(([modelId, record]) => projectModel(modelId, record));
  },

  async listProviders(ctx) {
    const providers = readProviders(ctx);
    const models = readModels(ctx);
    const globalDefaultModel = readDefaultModel(ctx);
    const out: ProviderCatalogItem[] = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      out.push(await toCatalogProvider(ctx, providerId, provider, models, globalDefaultModel));
    }
    return out;
  },

  async getProvider(ctx) {
    const providerId = ctx.args[0] as string;
    const provider = readProviders(ctx)[providerId];
    if (provider === undefined) {
      throw new RPCError(PROVIDER_NOT_FOUND, `provider ${providerId} does not exist`);
    }
    return toCatalogProvider(ctx, providerId, provider, readModels(ctx), readDefaultModel(ctx));
  },

  async setDefaultModel(ctx) {
    const modelId = ctx.args[0] as string;
    const models = readModels(ctx);
    const record = models[modelId];
    if (record === undefined) {
      throw new RPCError(MODEL_NOT_FOUND, `model ${modelId} does not exist`);
    }
    const data = readConfigForUpdate(ctx);
    data['defaultModel'] = modelId;
    writeConfig(ctx, data);
    return { default_model: modelId, model: projectModel(modelId, record) } satisfies SetDefaultModelResponse;
  },

  async generate(ctx) {
    return generateStream(ctx);
  },
};

// ── modelResolver.generate — the only streaming surface ─────────────────────

/** Ordered push-based event queue (port of v2 `AsyncEventQueue`). */
class EventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private error: unknown;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve({ done: false, value });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      if (this.error !== undefined) waiter.reject(this.error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.error = error;
    this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0;
    const queue = this;
    return {
      next(): Promise<IteratorResult<T>> {
        if (index < queue.buffer.length) {
          return Promise.resolve({ done: false, value: queue.buffer[index++]! });
        }
        if (queue.ended) {
          return queue.error !== undefined
            ? Promise.reject(queue.error)
            : Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
          queue.waiters.push({ resolve, reject });
        });
      },
      return(): Promise<IteratorResult<T>> {
        queue.ended = true;
        queue.buffer.length = 0;
        for (const waiter of queue.waiters.splice(0)) {
          waiter.resolve({ done: true, value: undefined });
        }
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

/** The kosong provider types the rust transport can construct. */
const KNOWN_PROVIDER_TYPES = new Set([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
  'astron',
]);

function resolveProtocol(
  record: ModelRecord,
  provider: ProviderConfigRecord | undefined,
): string {
  const protocol = nonEmpty(record['protocol']) ?? nonEmpty(provider?.['type']);
  if (protocol === undefined || !KNOWN_PROVIDER_TYPES.has(protocol)) return 'openai';
  return protocol;
}

/** Resolve per-request credentials: inline key → provider key → oauth token. */
async function resolveRequestAuth(
  ctx: RustCallContext,
  record: ModelRecord,
  provider: ProviderConfigRecord | undefined,
  providerId: string | undefined,
): Promise<ProviderRequestAuth | undefined> {
  const apiKey = nonEmpty(record['apiKey']) ?? nonEmpty(provider?.['apiKey']);
  if (apiKey !== undefined) return { apiKey };
  const oauthRef = provider?.['oauth'];
  if (isRecord(oauthRef)) {
    try {
      const token = await getToolkit(ctx)
        .tokenProvider(providerId ?? 'kimi', oauthRef as unknown as ManagedKimiOAuthRef)
        .getAccessToken();
      return token === undefined ? undefined : { bearerToken: token };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Build a kosong provider for one generate call. */
function buildChatProvider(
  protocol: string,
  record: ModelRecord,
  provider: ProviderConfigRecord | undefined,
  params: GenerateParamsLike | undefined,
): ChatProvider {
  const config = {
    type: protocol,
    model: nonEmpty(record['model']) ?? '',
    ...(nonEmpty(record['baseUrl']) !== undefined || nonEmpty(provider?.['baseUrl']) !== undefined
      ? { baseUrl: (nonEmpty(record['baseUrl']) ?? provider?.['baseUrl']) as string }
      : {}),
    ...(nonEmpty(record['apiKey']) !== undefined
      ? { apiKey: record['apiKey'] as string }
      : nonEmpty(provider?.['apiKey']) !== undefined
        ? { apiKey: provider?.['apiKey'] as string }
        : {}),
    ...(typeof record['maxOutputSize'] === 'number' ? { maxTokens: record['maxOutputSize'] } : {}),
    ...(typeof params?.temperature === 'number' ? { temperature: params.temperature } : {}),
    ...(params?.cacheKey !== undefined || typeof params?.topP === 'number'
      ? {
          generationKwargs: {
            ...(params?.cacheKey !== undefined ? { prompt_cache_key: params.cacheKey } : {}),
            ...(typeof params?.topP === 'number' ? { top_p: params.topP } : {}),
          },
        }
      : {}),
  } as ProviderConfig;
  return createProvider(config);
}

interface GenerateInputLike {
  readonly systemPrompt: string;
  readonly messages: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly responseFormat?: unknown;
}

interface GenerateParamsLike {
  readonly cacheKey?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly thinkingEffort?: string;
  readonly maxCompletionTokens?: number;
}

function generateStream(ctx: RustCallContext): AsyncIterable<unknown> {
  const queue = new EventQueue<unknown>();
  void runGenerate(ctx, queue).then(
    () => queue.end(),
    (error: unknown) => queue.fail(error),
  );
  return queue;
}

async function runGenerate(ctx: RustCallContext, queue: EventQueue<unknown>): Promise<void> {
  const [modelId, input, params] = ctx.args as [string, GenerateInputLike, GenerateParamsLike?];
  const models = readModels(ctx);
  const record = models[modelId];
  if (record === undefined) {
    throw new RPCError(MODEL_NOT_FOUND, `model ${modelId} does not exist`);
  }
  const providerId = nonEmpty(record['provider']) ?? nonEmpty(record['providerId']);
  const provider = providerId === undefined ? undefined : readProviders(ctx)[providerId];

  const protocol = resolveProtocol(record, provider);
  const wireModel = nonEmpty(record['model']) ?? modelId;
  let chatProvider = buildChatProvider(protocol, record, provider, params);
  if (params?.thinkingEffort !== undefined) {
    chatProvider = chatProvider.withThinking(params.thinkingEffort);
  }
  if (typeof params?.maxCompletionTokens === 'number') {
    chatProvider = chatProvider.withMaxCompletionTokens?.(params.maxCompletionTokens) ?? chatProvider;
  }

  const controller = new AbortController();
  const auth = await resolveRequestAuth(ctx, record, provider, providerId);
  let requestStartedAt = Date.now();
  let firstChunkAt: number | undefined;
  let streamEndedAt: number | undefined;

  const options: GenerateOptions = {
    signal: controller.signal,
    auth,
    ...(input.responseFormat !== undefined
      ? { responseFormat: input.responseFormat as GenerateOptions['responseFormat'] }
      : {}),
    onStreamEnd: () => {
      streamEndedAt = Date.now();
    },
  };

  const result = await generate(
    chatProvider,
    input.systemPrompt,
    [...(input.tools ?? [])] as Parameters<typeof generate>[2],
    [...input.messages] as Parameters<typeof generate>[3],
    {
      onMessagePart: (part: StreamedMessagePart) => {
        firstChunkAt ??= Date.now();
        queue.push({ type: 'part', part });
      },
    },
    options,
  );

  if (result.usage !== undefined && result.usage !== null) {
    queue.push({ type: 'usage', usage: result.usage, model: wireModel });
  }
  queue.push({
    type: 'finish',
    message: result.message,
    finishReason: result.finishReason ?? undefined,
    id: result.id ?? undefined,
  });
  if (firstChunkAt !== undefined) {
    queue.push({
      type: 'timing',
      firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
      streamDurationMs: Math.max(0, (streamEndedAt ?? Date.now()) - requestStartedAt),
    });
  }
}

// ── providerDiscovery — remote provider-model refresh ───────────────────────

/** The orchestrator's view of the user config (camelCase shape). */
function readManagedShape(ctx: RustCallContext): ManagedKimiConfigShape {
  const config = readConfig(ctx);
  return {
    providers: readProviders(ctx),
    models: readModels(ctx),
    defaultModel: readDefaultModel(ctx),
    ...(isRecord(config['thinking']) ? { thinking: config['thinking'] } : {}),
  };
}

/** Persist an orchestrator patch (deep-merge of the shape's sections). */
function applyManagedPatch(ctx: RustCallContext, patch: ManagedKimiConfigShape): ManagedKimiConfigShape {
  const data = readConfigForUpdate(ctx);
  if (patch.providers !== undefined) {
    data['providers'] = { ...(isRecord(data['providers']) ? data['providers'] : {}), ...patch.providers };
  }
  if (patch.models !== undefined) {
    data['models'] = { ...(isRecord(data['models']) ? data['models'] : {}), ...patch.models };
  }
  if ('defaultModel' in patch) {
    if (patch.defaultModel === undefined) delete data['defaultModel'];
    else data['defaultModel'] = patch.defaultModel;
  }
  if ('thinking' in patch) {
    if (patch.thinking === undefined) delete data['thinking'];
    else data['thinking'] = patch.thinking;
  }
  writeConfig(ctx, data);
  return patch;
}

export const providerDiscovery: RustServiceRegistry = {
  async refreshProviderModels(ctx) {
    const options = (ctx.args[0] ?? {}) as { scope?: 'all' | 'oauth'; providerId?: string };

    // Provider-scoped refresh validates the target and short-circuits
    // statically-sourced providers (v2 `effectiveModelSource === 'static'`).
    if (options.providerId !== undefined) {
      const provider = readProviders(ctx)[options.providerId];
      if (provider === undefined) {
        throw new RPCError(PROVIDER_NOT_FOUND, `provider ${options.providerId} does not exist`);
      }
      if (provider['modelSource'] === 'static') {
        return { changed: [], unchanged: [options.providerId], failed: [] } satisfies RefreshProviderModelsResponse;
      }
    }

    const host: RefreshProviderHost = {
      getConfig: async () => readManagedShape(ctx),
      removeProvider: async (providerId) => {
        const data = readConfigForUpdate(ctx);
        setSectionEntry(data, 'providers', providerId, undefined);
        const models = isRecord(data['models']) ? data['models'] : {};
        for (const [alias, model] of Object.entries(models)) {
          if (isRecord(model) && (model['provider'] === providerId || model['providerId'] === providerId)) {
            delete models[alias];
          }
        }
        if (Object.keys(models).length === 0) delete data['models'];
        writeConfig(ctx, data);
        return readManagedShape(ctx);
      },
      setConfig: async (patch) => applyManagedPatch(ctx, patch),
      resolveOAuthToken: async (providerName, oauthRef) =>
        getToolkit(ctx).tokenProvider(providerName, oauthRef).getAccessToken(),
    };

    const result = await refreshProviderModels(host, {
      scope: options.scope,
      providerId: options.providerId,
    });
    return {
      changed: result.changed.map((change) => ({
        provider_id: change.providerId,
        provider_name: change.providerName,
        added: change.added,
        removed: change.removed,
      })),
      unchanged: [...result.unchanged],
      failed: result.failed.map((failure) => ({ provider: failure.provider, reason: failure.reason })),
    } satisfies RefreshProviderModelsResponse;
  },
};

// ── flagService ─────────────────────────────────────────────────────────────

export const flagService: RustServiceRegistry = {
  async enabled(ctx) {
    const flagId = ctx.args[0] as string;
    const configValue = experimentalFlagValue(ctx, flagId);
    const def = FLAG_REGISTRY.find((candidate) => candidate.id === flagId);
    return def === undefined ? false : explainFlag(def, configValue).enabled;
  },

  async snapshot(ctx) {
    return Object.fromEntries(FLAG_REGISTRY.map((def) => [def.id, flagEnabled(ctx, def)]));
  },

  async enabledIds(ctx) {
    return FLAG_REGISTRY.filter((def) => flagEnabled(ctx, def)).map((def) => def.id);
  },

  async explain(ctx) {
    const flagId = ctx.args[0] as string;
    const configValue = experimentalFlagValue(ctx, flagId);
    const def = FLAG_REGISTRY.find((candidate) => candidate.id === flagId);
    return def === undefined ? undefined : explainFlag(def, configValue);
  },

  async explainAll(ctx) {
    return FLAG_REGISTRY.map((def) => explainFlag(def, experimentalFlagValue(ctx, def.id)));
  },
};

function flagEnabled(ctx: RustCallContext, def: FlagDefinition): boolean {
  return explainFlag(def, experimentalFlagValue(ctx, def.id)).enabled;
}

/** The `[experimental]` config value for one flag id (boolean|string → bool). */
function experimentalFlagValue(ctx: RustCallContext, flagId: string): boolean | undefined {
  const value = readExperimental(ctx)[flagId];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return parseBooleanEnv(value);
  return undefined;
}

// ── Service registration ────────────────────────────────────────────────────

registerService('flagService', flagService);
registerService('modelService', modelService);
registerService('modelResolver', modelResolver);
registerService('providerService', providerService);
registerService('providerDiscovery', providerDiscovery);
