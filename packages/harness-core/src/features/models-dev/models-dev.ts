import { omitUndefined, type CatalogModelConfig, type ModelCapability } from '@moonshot-ai/agent-core';

export interface ModelsDevModelEntry {
  readonly id?: string;
  readonly name?: string;
  readonly family?: string;
  readonly limit?: { readonly context?: number; readonly input?: number; readonly output?: number };
  readonly tool_call?: boolean;
  readonly reasoning?: boolean;
  readonly reasoning_options?: readonly ModelsDevReasoningOption[];
  readonly status?: string;
  readonly provider?: ModelsDevModelProviderOverride;
  readonly dynamically_loaded_tools?: boolean;
  readonly interleaved?: boolean | { readonly field?: string };
  readonly modalities?: {
    readonly input?: readonly string[];
    readonly output?: readonly string[];
  };
}

export interface ModelsDevReasoningOption {
  readonly type?: string;
  readonly values?: unknown;
}

export interface ModelsDevModelProviderOverride {
  readonly npm?: string;
  readonly api?: string;
}

export interface ModelsDevProviderEntry {
  readonly id?: string;
  readonly name?: string;
  readonly api?: string;
  readonly env?: readonly string[];
  readonly npm?: string;
  readonly type?: string;
  readonly models?: Record<string, ModelsDevModelEntry>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProviderEntry>;

const KNOWN_WIRE_TYPES = [
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
] as const;

export type ModelsDevWireType = (typeof KNOWN_WIRE_TYPES)[number];

function isWireType(value: unknown): value is ModelsDevWireType {
  return typeof value === 'string' && (KNOWN_WIRE_TYPES as readonly string[]).includes(value);
}

function hasEmbeddingMarker(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lower = value.toLowerCase();
  return lower.includes('embedding') || /(?:^|[-_/])embed(?:$|[-_/])/.test(lower);
}

function isUsableChatModel(model: ModelsDevModelEntry): boolean {
  const outputModalities = model.modalities?.output;
  if (outputModalities !== undefined && !outputModalities.includes('text')) return false;
  if (model.status === 'deprecated' || model.status === 'alpha') return false;
  return (
    !hasEmbeddingMarker(model.family) &&
    !hasEmbeddingMarker(model.id) &&
    !hasEmbeddingMarker(model.name)
  );
}

export type ModelsDevImportInvalidReason =
  | 'unknown-explicit-type'
  | 'proprietary-sdk'
  | 'empty-base-url'
  | 'placeholder-base-url';

export type ModelsDevImportResolution =
  | {
      readonly kind: 'ok';
      readonly wire: ModelsDevWireType;
      readonly guessed: boolean;
      readonly baseUrl?: string;
    }
  | {
      readonly kind: 'needs-base-url';
      readonly wire: ModelsDevWireType;
      readonly guessed: boolean;
    }
  | {
      readonly kind: 'invalid';
      readonly reason: ModelsDevImportInvalidReason;
    };

export function resolveModelsDevImport(
  entry: ModelsDevProviderEntry,
  userBaseUrl?: string,
): ModelsDevImportResolution {
  const wire = resolveModelsDevWire(entry);
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

  const catalogUrl = modelsDevBaseUrl(entry, wire);
  if (catalogUrl !== undefined) return { kind: 'ok', wire, guessed, baseUrl: catalogUrl };
  if (modelsDevEndpointRequired(entry, wire)) return { kind: 'needs-base-url', wire, guessed };
  return { kind: 'ok', wire, guessed };
}

function resolveModelsDevWire(entry: ModelsDevProviderEntry): ModelsDevWireType | undefined {
  if (isWireType(entry.type)) return entry.type;
  if (typeof entry.type === 'string' && entry.type.length > 0) return undefined;
  const declared = inferDeclaredWireType(entry);
  if (declared !== undefined) return declared;
  const npm = (entry.npm ?? '').toLowerCase();
  if (npm.includes('amazon-bedrock') || npm.includes('cohere')) return undefined;
  return 'openai';
}

function inferDeclaredWireType(entry: ModelsDevProviderEntry): ModelsDevWireType | undefined {
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

function modelsDevBaseUrl(entry: ModelsDevProviderEntry, wire: ModelsDevWireType): string | undefined {
  const api = entry.api;
  if (typeof api !== 'string' || api.length === 0 || api.includes('${')) return undefined;
  return adaptBaseUrlForWire(api, wire);
}

function adaptBaseUrlForWire(baseUrl: string, wire: ModelsDevWireType): string {
  return wire === 'anthropic' ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl;
}

function modelsDevEndpointRequired(entry: ModelsDevProviderEntry, wire: ModelsDevWireType): boolean {
  if (typeof entry.api === 'string' && entry.api.length > 0) return true;
  const npm = (entry.npm ?? '').toLowerCase();
  if (wire === 'openai' || wire === 'openai_responses') return npm !== '@ai-sdk/openai';
  if (wire === 'anthropic') return npm !== '@ai-sdk/anthropic';
  return false;
}

export interface ModelsDevImportedModel {
  readonly id: string;
  readonly name?: string;
  readonly maxContextSize: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
  readonly protocol?: 'anthropic';
  readonly baseUrl?: string;
  readonly capability: ModelCapability;
}

function modelsDevModelToImported(model: ModelsDevModelEntry): ModelsDevImportedModel | undefined {
  if (typeof model.id !== 'string' || model.id.length === 0) return undefined;
  const context = model.limit?.context;
  if (typeof context !== 'number' || !Number.isInteger(context) || context <= 0) return undefined;
  if (!isUsableChatModel(model)) return undefined;
  const inputs = model.modalities?.input ?? [];
  const output = model.limit?.output;
  const thinking = modelsDevThinkingOptions(model.reasoning_options);
  const input = model.limit?.input;
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name.length > 0 ? model.name : undefined,
    maxContextSize: context,
    maxInputSize:
      typeof input === 'number' && Number.isInteger(input) && input > 0
        ? Math.min(input, context)
        : undefined,
    maxOutputSize: typeof output === 'number' && output > 0 ? output : undefined,
    reasoningKey: modelsDevReasoningKey(model.interleaved),
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
      dynamically_loaded_tools: model.dynamically_loaded_tools === true,
    },
  };
}

function modelsDevThinkingOptions(options: ModelsDevModelEntry['reasoning_options']): {
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

function modelsDevReasoningKey(interleaved: ModelsDevModelEntry['interleaved']): string | undefined {
  if (typeof interleaved !== 'object' || interleaved === null) return undefined;
  const field = interleaved.field?.trim();
  return field !== undefined && field.length > 0 ? field : undefined;
}

export function modelsDevProviderModels(entry: ModelsDevProviderEntry): ModelsDevImportedModel[] {
  const providerWire = resolveModelsDevWire(entry);
  return Object.values(entry.models ?? {})
    .map((raw) => applyModelProviderOverride(modelsDevModelToImported(raw), raw, entry, providerWire))
    .filter((model): model is ModelsDevImportedModel => model !== undefined)
    .map((model) => {
      const protocol = model.protocol ?? providerWire;
      if (model.alwaysThinking === true && (protocol === 'anthropic' || protocol === 'kimi')) {
        const { alwaysThinking: _dropped, ...rest } = model;
        return rest as ModelsDevImportedModel;
      }
      return model;
    });
}

function applyModelProviderOverride(
  model: ModelsDevImportedModel | undefined,
  raw: ModelsDevModelEntry,
  entry: ModelsDevProviderEntry,
  providerWire: ModelsDevWireType | undefined,
): ModelsDevImportedModel | undefined {
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

function inferOverrideWire(npm: string): ModelsDevWireType | undefined {
  const normalized = npm.toLowerCase();
  if (normalized.includes('anthropic')) return 'anthropic';
  if (normalized.includes('vertex')) return 'vertexai';
  if (normalized.includes('google')) return 'google-genai';
  if (normalized.includes('openai')) return 'openai';
  return undefined;
}

export function modelsDevModelToConfig(
  providerId: string,
  model: ModelsDevImportedModel,
): CatalogModelConfig {
  const { dynamically_loaded_tools: dynamicallyLoadedTools, ...capability } = model.capability;
  return omitUndefined({
    provider: providerId,
    model: model.id,
    maxContextSize: model.maxContextSize,
    maxInputSize: model.maxInputSize,
    maxOutputSize: model.maxOutputSize,
    capability: dynamicallyLoadedTools === true ? model.capability : capability,
    displayName: model.name,
    reasoningKey: model.reasoningKey,
    supportEfforts: model.supportEfforts,
    offEffort: model.offEffort,
    alwaysThinking: model.alwaysThinking,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
  }) as CatalogModelConfig;
}

export interface ModelsDevModelItem {
  readonly id: string;
  readonly name?: string;
  readonly max_context_size: number;
  readonly capabilities?: readonly string[];
  readonly reasoning: boolean;
}

export interface ModelsDevProviderItem {
  readonly id: string;
  readonly name: string;
  readonly wire_type: string | null;
  readonly guessed: boolean;
  readonly needs_base_url: boolean;
  readonly rejected: boolean;
  readonly reject_reason: string | null;
  readonly env_key: string | null;
  readonly models: readonly ModelsDevModelItem[];
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

function toModelItem(model: ModelsDevImportedModel): ModelsDevModelItem {
  return {
    id: model.id,
    name: model.name,
    max_context_size: model.maxContextSize,
    capabilities: capabilityToStrings(model.capability),
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
  throw new Error(`unhandled models.dev import resolution: ${JSON.stringify(resolution)}`);
}
