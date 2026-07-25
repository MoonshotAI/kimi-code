/**
 * `kosong/model` domain (L2) — the `IModelCatalog.inspect` payload and its
 * assembly.
 *
 * The inspection is a *god object* for one configured model: the raw config
 * layers (`[models.*]` record + effective record, `[providers.*]` config +
 * provider-definition facts) beside the
 * resolved runtime view — plus `sources`, a dot-path → provenance map that
 * answers "where did this value come from" (`config` / `override` /
 * `builtin` / `env` / `synthesized` / `none`).
 *
 * Everything here is on-demand: `ModelCatalog.entry` captures a
 * `ResolutionTraceCollector` while resolving (reference-only, no copies), and
 * `assembleModelInspection` builds the god object — including secret
 * redaction — only when `inspect` is called. The trace and the resolved
 * Model come from the SAME resolution pass, so the inspection can never
 * drift from what `get` served (same config generation, same cache entry).
 */

import { parseKimiCodeCustomHeaders } from '@moonshot-ai/kimi-code-oauth';

import type { ModelCapability } from '#/kosong/contract/capability';
import type { InspectionSource, ResolutionTrace } from '#/kosong/contract/inspection';
import type { Protocol, ProtocolProviderOptions } from '#/kosong/protocol/protocol';

import type { AnthropicModelProfile } from '../provider/bases/anthropic/anthropic-profile';
import type { ProviderConfig } from '../provider/provider';
import { getProviderDefinition } from '../provider/providerDefinition';

import type { ModelRecord } from './model';
import type { ResolvedModelAuthMaterial } from './model.types';

// ---------------------------------------------------------------------------
// Inspection payload
// ---------------------------------------------------------------------------

export interface InspectedAuth {
  readonly kind: 'apiKey' | 'oauth' | 'none';
  /** Masked (`••••` + last 4) when present — never the raw secret. */
  readonly apiKey?: string;
  readonly oauthProviderKey?: string;
}

/** The resolved runtime view — `Model` minus the `authProvider` closure. */
export interface InspectedResolvedModel {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly providerName: string;
  readonly baseUrl?: string;
  readonly wireName: string;
  readonly aliases: readonly string[];
  readonly auth: InspectedAuth;
  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly alwaysThinking: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly providerOptions?: ProtocolProviderOptions;
}

export interface ModelInspection {
  readonly id: string;
  readonly model: {
    readonly id: string;
    /** Raw `[models.*]` record, secrets masked. */
    readonly record: ModelRecord;
    /** After overrides merge + the Anthropic profile pass, secrets masked. */
    readonly effective: ModelRecord;
  };
  readonly provider: {
    readonly id: string;
    /** True for flat models: the provider was synthesized from the baseUrl host. */
    readonly synthesized: boolean;
    readonly config?: ProviderConfig;
    /** Vendor-registry facts (definition-level endpoint declaration: env NAMES, never values). */
    readonly definition?: {
      readonly registered: boolean;
      readonly baseProtocol?: Protocol;
      readonly modelSource?: string;
      readonly hostHeaders?: string;
      readonly endpoint?: unknown;
    };
  };
  readonly resolved: InspectedResolvedModel;
  readonly sources: Readonly<Record<string, InspectionSource>>;
}

// ---------------------------------------------------------------------------
// Trace collector
// ---------------------------------------------------------------------------

/** Capture keys shared between the resolver and the assembly. */
export const TRACE = {
  configuredModel: 'configuredModel',
  effectiveModel: 'effectiveModel',
  providerConfig: 'providerConfig',
  providerName: 'providerName',
  providerSynthesized: 'providerSynthesized',
  rawBaseUrl: 'rawBaseUrl',
  authMaterial: 'authMaterial',
  detectedCapability: 'detectedCapability',
  capabilitySource: 'capabilitySource',
  hostHeaders: 'hostHeaders',
} as const;

export class ResolutionTraceCollector implements ResolutionTrace {
  private readonly sourceMap = new Map<string, InspectionSource>();
  private readonly captureMap = new Map<string, unknown>();

  record(path: string, source: InspectionSource): void {
    this.sourceMap.set(path, source);
  }

  capture(key: string, value: unknown): void {
    this.captureMap.set(key, value);
  }

  captured<T>(key: string): T | undefined {
    return this.captureMap.get(key) as T | undefined;
  }

  get sources(): ReadonlyMap<string, InspectionSource> {
    return this.sourceMap;
  }
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /api[-_]?key|token|secret|password|authorization/i;

export function maskSecret(value: string): string {
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

/** Deep-copy with every string under a secret-looking key masked. */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = typeof item === 'string' && SECRET_KEY_RE.test(key) ? maskSecret(item) : redactSecrets(item);
    }
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Field attribution helpers (called from the resolver while the trace is live)
// ---------------------------------------------------------------------------

/**
 * Attribute every leaf of the effective record: `override` for keys the
 * `overrides` block set, `builtin` for values the Anthropic profile pass
 * filled in or changed (capabilities / supportEfforts / defaultEffort),
 * `synthesized` for the pruned defaultEffort, `config` for everything that
 * came straight through from the raw record.
 */
export function attributeEffectiveFields(
  trace: ResolutionTraceCollector,
  configured: ModelRecord,
  effective: ModelRecord,
  profile: AnthropicModelProfile | undefined,
  profileInferred: boolean,
): void {
  const { overrides, ...base } = configured;
  const overridden = new Set(Object.keys(overrides ?? {}));
  const profileDetail =
    profile === undefined
      ? undefined
      : `anthropic profile (${profile.mode}, efforts: ${profile.efforts.join('/')}${profileInferred ? ', inferred fallback' : ''})`;
  const keys = new Set([...Object.keys(base), ...Object.keys(effective)]);
  for (const key of keys) {
    if (key === 'overrides') continue;
    const path = `model.effective.${key}`;
    const before = (base as Record<string, unknown>)[key];
    const after = (effective as Record<string, unknown>)[key];
    if (before === undefined && after === undefined) continue;
    if (key === 'maxInputSize') {
      const rawValue = (overridden.has(key) ? overrides?.[key] : before) as number | undefined;
      if (
        rawValue !== undefined &&
        effective.maxContextSize !== undefined &&
        rawValue > effective.maxContextSize
      ) {
        trace.record(path, {
          kind: 'synthesized',
          detail: 'clamped to the effective max_context_size',
        });
        continue;
      }
    }
    if (overridden.has(key)) {
      trace.record(path, { kind: 'override', detail: 'models.*.overrides' });
      continue;
    }
    if (after === undefined) {
      trace.record(path, {
        kind: 'synthesized',
        detail: 'removed by the effective pass (defaultEffort not in override supportEfforts)',
      });
      continue;
    }
    const profileTouched =
      (key === 'capabilities' || key === 'supportEfforts' || key === 'defaultEffort') &&
      profileDetail !== undefined &&
      JSON.stringify(before) !== JSON.stringify(after);
    if (profileTouched) {
      trace.record(path, { kind: 'builtin', detail: profileDetail });
      continue;
    }
    trace.record(path, { kind: 'config', detail: '[models.*] section' });
  }
}

const PROVIDER_OPTION_FIELD: Readonly<Record<string, string>> = {
  defaultMaxTokens: 'maxOutputSize',
  supportEfforts: 'supportEfforts',
  adaptiveThinking: 'adaptiveThinking',
  betaApi: 'betaApi',
  reasoningKey: 'reasoningKey',
};

/** Attribute each `resolved.providerOptions.*` key back to its model field or the provider env bag. */
export function attributeProviderOptions(
  trace: ResolutionTraceCollector,
  options: ProtocolProviderOptions,
  providerEnv: Readonly<Record<string, string>> | undefined,
): void {
  for (const key of Object.keys(options)) {
    const path = `resolved.providerOptions.${key}`;
    if (key === 'vertexai') {
      trace.record(path, { kind: 'env', detail: 'provider env bag supplies both vertex coordinates' });
      continue;
    }
    if (key === 'project') {
      trace.record(path, { kind: 'env', detail: 'GOOGLE_CLOUD_PROJECT (provider env bag)' });
      continue;
    }
    if (key === 'location') {
      trace.record(
        path,
        providerEnv?.['GOOGLE_CLOUD_LOCATION'] !== undefined
          ? { kind: 'env', detail: 'GOOGLE_CLOUD_LOCATION (provider env bag)' }
          : { kind: 'synthesized', detail: 'parsed from the baseUrl host' },
      );
      continue;
    }
    const field = PROVIDER_OPTION_FIELD[key];
    const source = field === undefined ? undefined : trace.sources.get(`model.effective.${field}`);
    trace.record(path, source ?? { kind: 'config', detail: '[models.*] section' });
  }
}

// ---------------------------------------------------------------------------
// Assembly (on-demand, only when `inspect` is called)
// ---------------------------------------------------------------------------

interface ResolvedModelLike {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly providerName: string;
  readonly baseUrl?: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly alwaysThinking: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly providerOptions?: ProtocolProviderOptions;
}

const CAPABILITY_KEYS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const;

/**
 * Build the god object from the trace of one resolution pass and the Model it
 * produced. Adds the derived annotations (mirrored `resolved.*` sources,
 * per-key capability / header attribution) on top of the resolver-recorded
 * ones. All secrets are masked here — the trace holds raw values in memory
 * (as does the resolved Model's auth closure), the payload never does.
 */
export function assembleModelInspection(args: {
  readonly id: string;
  readonly model: ResolvedModelLike;
  readonly trace: ResolutionTraceCollector;
}): ModelInspection {
  const { id, model, trace } = args;
  const configured = required<ModelRecord>(trace, TRACE.configuredModel, 'configured model');
  const effective = required<ModelRecord>(trace, TRACE.effectiveModel, 'effective model');
  const providerConfig = trace.captured<ProviderConfig>(TRACE.providerConfig);
  const providerName = trace.captured<string>(TRACE.providerName) ?? model.providerName;
  const providerSynthesized = trace.captured<boolean>(TRACE.providerSynthesized) === true;
  const rawBaseUrl = trace.captured<string>(TRACE.rawBaseUrl);
  const authMaterial = trace.captured<ResolvedModelAuthMaterial>(TRACE.authMaterial) ?? {};

  const sources = new Map<string, InspectionSource>([
    ...trace.sources,
    [
      'model.effective',
      {
        kind: 'synthesized',
        detail: 'overrides merged into the raw record, then the Anthropic profile pass fills gaps',
      } satisfies InspectionSource,
    ],
    [
      'resolved',
      {
        kind: 'synthesized',
        detail: 'the assembled runtime view (Model) of this same resolution pass',
      } satisfies InspectionSource,
    ],
  ]);

  // Mirror the effective-field sources onto their resolved counterparts.
  for (const field of [
    'maxContextSize',
    'maxInputSize',
    'maxOutputSize',
    'displayName',
    'reasoningKey',
    'supportEfforts',
    'defaultEffort',
    'aliases',
  ] as const) {
    const source = sources.get(`model.effective.${field}`);
    if (source !== undefined) sources.set(`resolved.${field}`, source);
  }
  const wireNameField = effective.name !== undefined ? 'name' : 'model';
  sources.set(
    'resolved.wireName',
    sources.get(`model.effective.${wireNameField}`) ?? { kind: 'config', detail: '[models.*] section' },
  );
  sources.set('resolved.alwaysThinking', {
    kind: 'synthesized',
    detail: "derived from the declared capabilities ('always_thinking' present)",
  });
  sources.set(
    'resolved.providerType',
    providerConfig !== undefined
      ? { kind: 'config', detail: `provider '${providerName}' type` }
      : { kind: 'synthesized', detail: 'no provider — falls back to the resolved protocol' },
  );
  sources.set(
    'resolved.providerName',
    sources.get('provider') ?? { kind: 'config', detail: `provider '${providerName}'` },
  );

  // Node-level annotations for structural fields that otherwise render
  // without any provenance (ids, the headers merge).
  sources.set('model', { kind: 'config', detail: 'the [models.*] section entry' });
  sources.set('model.id', { kind: 'config', detail: 'the [models.*] section key' });
  sources.set('resolved.headers', {
    kind: 'synthesized',
    detail: 'env < host < provider customHeaders merge (later wins)',
  });

  const baseUrlSource = sources.get('resolved.baseUrl');
  if (
    baseUrlSource !== undefined &&
    model.protocol === 'anthropic' &&
    rawBaseUrl !== undefined &&
    rawBaseUrl !== model.baseUrl
  ) {
    sources.set('resolved.baseUrl', {
      kind: 'synthesized',
      detail: `${baseUrlSource.detail ?? baseUrlSource.kind} · trailing /v1 stripped`,
    });
  }

  attributeCapabilities(sources, configured, effective, trace);
  attributeHeaders(sources, model, providerConfig, trace);

  // Provider definition facts (vendor-registry knowledge, never config).
  const providerType = providerConfig?.type;
  const definition = providerType === undefined ? undefined : getProviderDefinition(providerType);
  if (providerConfig !== undefined) {
    sources.set('provider.config', { kind: 'config', detail: '[providers.*] section' });
    sources.set('provider.definition', {
      kind: 'builtin',
      detail:
        definition === undefined
          ? `vendor '${providerType}' is not registered in the provider-definition registry`
          : `provider definition '${providerType}'`,
    });
  }

  const auth: InspectedAuth =
    authMaterial.apiKey !== undefined
      ? { kind: 'apiKey', apiKey: maskSecret(authMaterial.apiKey) }
      : authMaterial.oauth !== undefined
        ? { kind: 'oauth', oauthProviderKey: authMaterial.oauthProviderKey }
        : { kind: 'none' };

  return {
    id,
    model: {
      id,
      record: redactSecrets(configured),
      effective: redactSecrets(effective),
    },
    provider: {
      id: providerName,
      synthesized: providerSynthesized,
      config: providerConfig === undefined ? undefined : redactSecrets(providerConfig),
      definition:
        providerConfig === undefined
          ? undefined
          : {
              registered: definition !== undefined,
              ...(definition === undefined
                ? undefined
                : {
                    baseProtocol: definition.baseProtocol,
                    modelSource: definition.modelSource,
                    hostHeaders: definition.hostHeaders,
                    endpoint: definition.endpoint,
                  }),
            },
    },
    resolved: {
      protocol: model.protocol,
      providerType: model.providerType,
      providerName: model.providerName,
      baseUrl: model.baseUrl,
      wireName: model.name,
      aliases: model.aliases,
      auth,
      capabilities: model.capabilities,
      maxContextSize: model.maxContextSize,
      maxInputSize: model.maxInputSize,
      maxOutputSize: model.maxOutputSize,
      displayName: model.displayName,
      reasoningKey: model.reasoningKey,
      supportEfforts: model.supportEfforts,
      defaultEffort: model.defaultEffort,
      alwaysThinking: model.alwaysThinking,
      headers: model.headers,
      providerOptions: model.providerOptions,
    },
    sources: Object.fromEntries(sources),
  };
}

function attributeCapabilities(
  sources: Map<string, InspectionSource>,
  configured: ModelRecord,
  effective: ModelRecord,
  trace: ResolutionTraceCollector,
): void {
  // The raw record declares with `config`; the profile pass may append
  // thinking capabilities on top — those are `builtin`, like the profile
  // itself. (The runtime merge uses the effective record either way.)
  const raw = new Set((configured.capabilities ?? []).map((c) => c.trim().toLowerCase()));
  const added = new Set((effective.capabilities ?? []).map((c) => c.trim().toLowerCase()));
  const detected = trace.captured<ModelCapability>(TRACE.detectedCapability);
  const detectedSource = trace.captured<InspectionSource>(TRACE.capabilitySource) ?? {
    kind: 'none' as const,
  };
  const profileSource = sources.get('model.effective.capabilities');
  for (const key of CAPABILITY_KEYS) {
    const path = `resolved.capabilities.${key}`;
    if (raw.has(key) || (key === 'thinking' && raw.has('always_thinking'))) {
      sources.set(path, { kind: 'config', detail: 'declared in model capabilities' });
      continue;
    }
    if (added.has(key) || (key === 'thinking' && added.has('always_thinking'))) {
      sources.set(
        path,
        profileSource ?? { kind: 'builtin', detail: 'added by the Anthropic profile pass' },
      );
      continue;
    }
    if (detected?.[key] === true) {
      sources.set(path, detectedSource);
      continue;
    }
    sources.set(path, { kind: 'none', detail: 'neither declared nor detected' });
  }
  sources.set('resolved.capabilities.max_context_tokens', {
    kind: 'synthesized',
    detail: 'forced to the resolved maxContextSize',
  });
  const maxInputSource = sources.get('model.effective.maxInputSize');
  sources.set(
    'resolved.capabilities.max_input_tokens',
    maxInputSource ?? {
      kind: 'none',
      detail: 'no declared input limit — the total window applies',
    },
  );
}

function attributeHeaders(
  sources: Map<string, InspectionSource>,
  model: ResolvedModelLike,
  providerConfig: ProviderConfig | undefined,
  trace: ResolutionTraceCollector,
): void {
  const envLayer = parseKimiCodeCustomHeaders();
  const rawHost = trace.captured<Readonly<Record<string, string>>>(TRACE.hostHeaders) ?? {};
  const forwardsAll =
    providerConfig?.type !== undefined &&
    getProviderDefinition(providerConfig.type)?.hostHeaders === 'full';
  const hostLayer: Readonly<Record<string, string>> = forwardsAll
    ? rawHost
    : rawHost['User-Agent'] === undefined
      ? {}
      : { 'User-Agent': rawHost['User-Agent'] };
  const customLayer = providerConfig?.customHeaders ?? {};
  // The merge order is env < host < custom (resolveOutboundHeaders); the
  // winner of each final key is attributed, losers are shadowed silently.
  for (const key of Object.keys(model.headers)) {
    const path = `resolved.headers.${key}`;
    if (key in customLayer) {
      sources.set(path, { kind: 'config', detail: "provider's customHeaders" });
    } else if (key in hostLayer) {
      sources.set(path, {
        kind: 'builtin',
        detail: forwardsAll ? "host request headers (hostHeaders: 'full')" : 'host User-Agent',
      });
    } else if (key in envLayer) {
      sources.set(path, { kind: 'env', detail: 'KIMI_CODE_CUSTOM_HEADERS' });
    }
  }
}

function required<T>(trace: ResolutionTraceCollector, key: string, what: string): T {
  const value = trace.captured<T>(key);
  if (value === undefined) {
    throw new Error(`resolution trace is missing the ${what} capture ('${key}')`);
  }
  return value;
}
