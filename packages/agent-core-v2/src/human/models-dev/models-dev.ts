import type { CatalogModelDefinition } from '#/llm/provider-catalog';

export type ModelsDevWire =
  | 'anthropic'
  | 'openai'
  | 'openai_responses'
  | 'google-genai'
  | 'google-vertex'
  | 'kimi';

export interface ModelsDevModelEntry {
  readonly id?: string;
  readonly name?: string;
  readonly family?: string;
  readonly limit?: { readonly context?: number; readonly input?: number; readonly output?: number };
  readonly tool_call?: boolean;
  readonly dynamically_loaded_tools?: boolean;
  readonly reasoning?: boolean;
  readonly reasoning_options?: readonly ModelsDevReasoningOption[];
  readonly status?: string;
  readonly provider?: ModelsDevModelProviderOverride;
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
  readonly api?: string;
  readonly npm?: string;
  readonly type?: string;
  readonly models?: Record<string, ModelsDevModelEntry>;
}

export type ModelsDevImportInvalidReason =
  | 'unknown-explicit-type'
  | 'proprietary-sdk'
  | 'empty-base-url'
  | 'placeholder-base-url';

export type ModelsDevImportResolution =
  | {
      readonly kind: 'ok';
      readonly wire: ModelsDevWire;
      readonly guessed: boolean;
      readonly baseUrl?: string;
    }
  | { readonly kind: 'needs-base-url'; readonly wire: ModelsDevWire; readonly guessed: boolean }
  | { readonly kind: 'invalid'; readonly reason: ModelsDevImportInvalidReason };

const KNOWN_WIRES = [
  'anthropic',
  'openai',
  'openai_responses',
  'google-genai',
  'google-vertex',
  'kimi',
] as const satisfies readonly ModelsDevWire[];

function isModelsDevWire(value: unknown): value is ModelsDevWire {
  return typeof value === 'string' && (KNOWN_WIRES as readonly string[]).includes(value);
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
  const guessed = inferDeclaredWire(entry) === undefined;

  if (userBaseUrl !== undefined) {
    const trimmed = userBaseUrl.trim();
    if (trimmed.length === 0) return { kind: 'invalid', reason: 'empty-base-url' };
    if (trimmed.includes('${')) return { kind: 'invalid', reason: 'placeholder-base-url' };
    return { kind: 'ok', wire, guessed, baseUrl: adaptBaseUrlForWire(trimmed, wire) };
  }

  const modelsDevUrl = modelsDevBaseUrl(entry, wire);
  if (modelsDevUrl !== undefined) return { kind: 'ok', wire, guessed, baseUrl: modelsDevUrl };
  if (modelsDevEndpointRequired(entry, wire)) return { kind: 'needs-base-url', wire, guessed };
  return { kind: 'ok', wire, guessed };
}

function resolveModelsDevWire(entry: ModelsDevProviderEntry): ModelsDevWire | undefined {
  if (isModelsDevWire(entry.type)) return entry.type;
  if (typeof entry.type === 'string' && entry.type.length > 0) return undefined;
  const declared = inferDeclaredWire(entry);
  if (declared !== undefined) return declared;
  const npm = (entry.npm ?? '').toLowerCase();
  if (npm.includes('amazon-bedrock') || npm.includes('cohere')) return undefined;
  return 'openai';
}

function inferDeclaredWire(entry: ModelsDevProviderEntry): ModelsDevWire | undefined {
  if (isModelsDevWire(entry.type)) return entry.type;
  const npm = (entry.npm ?? '').toLowerCase();
  const id = (entry.id ?? '').toLowerCase();
  if (npm.includes('anthropic') || id.includes('anthropic') || id.includes('claude')) {
    return 'anthropic';
  }
  if (id.includes('vertex')) return 'google-vertex';
  if (npm.includes('google') || id.includes('google') || id.includes('gemini')) {
    return 'google-genai';
  }
  if (npm.includes('openai') || id.includes('openai')) return 'openai';
  return undefined;
}

function modelsDevBaseUrl(entry: ModelsDevProviderEntry, wire: ModelsDevWire): string | undefined {
  const api = entry.api;
  if (typeof api !== 'string' || api.length === 0 || api.includes('${')) return undefined;
  return adaptBaseUrlForWire(api, wire);
}

function adaptBaseUrlForWire(baseUrl: string, wire: ModelsDevWire): string {
  return wire === 'anthropic' ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl;
}

function modelsDevEndpointRequired(entry: ModelsDevProviderEntry, wire: ModelsDevWire): boolean {
  if (typeof entry.api === 'string' && entry.api.length > 0) return true;
  const npm = (entry.npm ?? '').toLowerCase();
  if (wire === 'openai' || wire === 'openai_responses') return npm !== '@ai-sdk/openai';
  if (wire === 'anthropic') return npm !== '@ai-sdk/anthropic';
  return false;
}

function normalizeModelsDevModel(
  providerId: string,
  model: ModelsDevModelEntry,
): CatalogModelDefinition | undefined {
  if (typeof model.id !== 'string' || model.id.length === 0) return undefined;
  const context = model.limit?.context;
  if (typeof context !== 'number' || !Number.isInteger(context) || context <= 0) return undefined;
  if (!isUsableChatModel(model)) return undefined;
  const inputs = model.modalities?.input ?? [];
  const output = model.limit?.output;
  const thinking = modelsDevThinkingOptions(model.reasoning_options);
  const input = model.limit?.input;
  const maxInputTokens =
    typeof input === 'number' && Number.isInteger(input) && input > 0
      ? Math.min(input, context)
      : undefined;
  return {
    provider: providerId,
    model: model.id,
    displayName: typeof model.name === 'string' && model.name.length > 0 ? model.name : undefined,
    maxContextSize: context,
    maxInputSize: maxInputTokens,
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
    return {
      efforts: undefined,
      offEffort: undefined,
      hasToggle: false,
      alwaysThinking: undefined,
    };
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

export function modelsDevProviderModels(
  providerId: string,
  entry: ModelsDevProviderEntry,
): CatalogModelDefinition[] {
  const providerWire = resolveModelsDevWire(entry);
  return Object.values(entry.models ?? {})
    .map((raw) => {
      const resolved = applyModelProviderOverride(
        normalizeModelsDevModel(providerId, raw),
        raw,
        entry,
        providerWire,
      );
      return resolved === undefined
        ? undefined
        : dropAlwaysThinkingForWire(resolved.model, resolved.wire);
    })
    .filter((model): model is CatalogModelDefinition => model !== undefined);
}

function dropAlwaysThinkingForWire(
  model: CatalogModelDefinition,
  wire: ModelsDevWire | undefined,
): CatalogModelDefinition {
  return model.alwaysThinking === true && (wire === 'anthropic' || wire === 'kimi')
    ? { ...model, alwaysThinking: undefined }
    : model;
}

function applyModelProviderOverride(
  model: CatalogModelDefinition | undefined,
  raw: ModelsDevModelEntry,
  entry: ModelsDevProviderEntry,
  providerWire: ModelsDevWire | undefined,
): { model: CatalogModelDefinition; wire: ModelsDevWire | undefined } | undefined {
  if (model === undefined) return undefined;
  const override = raw.provider;
  if (override === undefined) return { model, wire: providerWire };
  const overrideNpm = typeof override.npm === 'string' ? override.npm.toLowerCase() : undefined;
  if (
    overrideNpm !== undefined &&
    (overrideNpm.includes('amazon-bedrock') || overrideNpm.includes('cohere'))
  ) {
    return undefined;
  }
  const overrideWire =
    overrideNpm !== undefined ? (inferOverrideWire(overrideNpm) ?? 'openai') : providerWire;
  if (overrideWire === undefined) return { model, wire: providerWire };
  const rawApi = override.api;
  const api = rawApi ?? entry.api;
  const usableApi =
    typeof api === 'string' && api.length > 0 && !api.includes('${') ? api : undefined;

  if (overrideWire === providerWire) {
    if (typeof rawApi === 'string' && rawApi.includes('${')) return undefined;
    if (usableApi !== undefined && usableApi !== entry.api) {
      return {
        model: { ...model, baseUrl: adaptBaseUrlForWire(usableApi, overrideWire) },
        wire: overrideWire,
      };
    }
    return { model, wire: overrideWire };
  }

  if (overrideWire === 'anthropic' && usableApi !== undefined) {
    return {
      model: {
        ...model,
        protocol: 'anthropic',
        baseUrl: adaptBaseUrlForWire(usableApi, 'anthropic'),
      },
      wire: 'anthropic',
    };
  }
  return undefined;
}

function inferOverrideWire(npm: string): ModelsDevWire | undefined {
  const normalized = npm.toLowerCase();
  if (normalized.includes('anthropic')) return 'anthropic';
  if (normalized.includes('vertex')) return 'google-vertex';
  if (normalized.includes('google')) return 'google-genai';
  if (normalized.includes('openai')) return 'openai';
  return undefined;
}
