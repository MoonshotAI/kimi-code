import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';
import { parseKimiCodeCustomHeaders } from './identity';
import { parseSupportsThinkingType, parseThinkEfforts } from './managed-kimi-code';
import { MANAGED_KIMI_MODEL_FIELDS, mergeRefreshedModelAlias } from './model-alias-merge';
import type {
  ManagedKimiCodeModelInfo,
  ManagedKimiConfigShape,
  ManagedKimiModelAlias,
} from './managed-kimi-code';

export type { ManagedKimiConfigShape };

export interface OpenPlatformDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly consoleUrl?: string;
  readonly allowedPrefixes?: readonly string[] | undefined;
}

export const OPEN_PLATFORMS: readonly OpenPlatformDefinition[] = [
  {
    id: 'moonshot-cn',
    name: 'Kimi Platform (API key · platform.kimi.com)',
    baseUrl: 'https://api.moonshot.cn/v1',
    consoleUrl: 'https://platform.kimi.com',
    allowedPrefixes: ['kimi-k'],
  },
  {
    id: 'moonshot-ai',
    name: 'Kimi Platform (API key · platform.kimi.ai)',
    baseUrl: 'https://api.moonshot.ai/v1',
    consoleUrl: 'https://platform.kimi.ai',
    allowedPrefixes: ['kimi-k'],
  },
];

export function getOpenPlatformById(id: string): OpenPlatformDefinition | undefined {
  return OPEN_PLATFORMS.find((p) => p.id === id);
}

export function isOpenPlatformId(id: string): boolean {
  return OPEN_PLATFORMS.some((p) => p.id === id);
}

function toModelInfo(item: unknown): ManagedKimiCodeModelInfo | undefined {
  if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
    return undefined;
  }
  const contextLength = Number(item['context_length']);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    throw new Error(`Model "${item['id']}" must include a positive context_length.`);
  }
  const displayName = item['display_name'];
  const normalizedDisplayName =
    typeof displayName === 'string' && displayName.length > 0 ? displayName : undefined;
  const supportsToolUse = Object.hasOwn(item, 'supports_tool_use')
    ? Boolean(item['supports_tool_use'])
    : true;
  // Effort levels come from the nested `think_efforts` object
  // ({ support, valid_efforts, default_effort }) returned by /models.
  const thinkEfforts = parseThinkEfforts(item['think_efforts']);
  return {
    id: item['id'],
    contextLength,
    supportsReasoning: Boolean(item['supports_reasoning']),
    supportsImageIn: Boolean(item['supports_image_in']),
    supportsVideoIn: Boolean(item['supports_video_in']),
    supportsToolUse,
    supportsThinkingType: parseSupportsThinkingType(item['supports_thinking_type']),
    supportEfforts: thinkEfforts.supportEfforts,
    defaultEffort: thinkEfforts.defaultEffort,
    displayName: normalizedDisplayName,
  };
}

export function capabilitiesForModel(model: ManagedKimiCodeModelInfo): string[] | undefined {
  const caps = new Set<string>();
  // supports_thinking_type is the full three-state declaration and wins over
  // the legacy supports_reasoning boolean; absent (older servers) falls back.
  switch (model.supportsThinkingType) {
    case 'only':
      caps.add('thinking');
      caps.add('always_thinking');
      break;
    case 'both':
      caps.add('thinking');
      break;
    case 'no':
      break;
    case undefined:
      if (model.supportsReasoning) caps.add('thinking');
      break;
  }
  if (model.supportsImageIn) caps.add('image_in');
  if (model.supportsVideoIn) caps.add('video_in');
  if (model.supportsToolUse ?? true) caps.add('tool_use');
  return caps.size > 0 ? [...caps] : undefined;
}

export class OpenPlatformApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchOpenPlatformModels(
  platform: OpenPlatformDefinition,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ManagedKimiCodeModelInfo[]> {
  const res = await fetchImpl(`${platform.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: {
      ...parseKimiCodeCustomHeaders(),
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal,
  });
  if (!res.ok) {
    throw new OpenPlatformApiError(
      await readApiErrorMessage(res, `Failed to list models (HTTP ${res.status}).`),
      res.status,
    );
  }
  const payload: unknown = await res.json();
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`Unexpected models response for ${platform.baseUrl}.`);
  }
  return payload['data']
    .map((item) => toModelInfo(item))
    .filter((item): item is ManagedKimiCodeModelInfo => item !== undefined);
}

export function filterModelsByPrefix(
  models: ManagedKimiCodeModelInfo[],
  platform: OpenPlatformDefinition,
): ManagedKimiCodeModelInfo[] {
  if (!platform.allowedPrefixes || platform.allowedPrefixes.length === 0) {
    return models;
  }
  const prefixes = platform.allowedPrefixes;
  return models.filter((m) => prefixes.some((p) => m.id.startsWith(p)));
}

export interface ApplyOpenPlatformResult {
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
}

export function applyOpenPlatformConfig(
  config: ManagedKimiConfigShape,
  options: {
    readonly platform: OpenPlatformDefinition;
    readonly models: readonly ManagedKimiCodeModelInfo[];
    readonly selectedModel: ManagedKimiCodeModelInfo;
    readonly thinking: boolean;
    /** Concrete thinking effort to persist (e.g. 'low'/'high'/'max'). Omit
     * for boolean models, where thinking is simply enabled with no effort. */
    readonly effort?: string;
    readonly apiKey: string;
  },
): ApplyOpenPlatformResult {
  const providerKey = options.platform.id;
  const modelKey = `${providerKey}/${options.selectedModel.id}`;

  config.providers[providerKey] = {
    type: 'kimi',
    baseUrl: options.platform.baseUrl,
    apiKey: options.apiKey,
  };

  const existingModels = config.models ?? {};
  // Selectively merge upstream models into the existing config so any fields
  // the user added by hand (or that upstream does not declare) survive a
  // refresh. Models that upstream no longer lists are removed; the rest are
  // merged field-by-field.
  const upstreamKeys = new Set(options.models.map((m) => `${providerKey}/${m.id}`));
  for (const [key, model] of Object.entries(existingModels)) {
    if (isRecord(model) && model['provider'] === providerKey && !upstreamKeys.has(key)) {
      delete existingModels[key];
    }
  }

  for (const model of options.models) {
    const aliasKey = `${providerKey}/${model.id}`;
    const existing = isRecord(existingModels[aliasKey]) ? existingModels[aliasKey] : {};
    const remoteAlias: ManagedKimiModelAlias = {
      provider: providerKey,
      model: model.id,
      maxContextSize: model.contextLength,
      capabilities: capabilitiesForModel(model),
      ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
      ...(model.supportEfforts !== undefined ? { supportEfforts: model.supportEfforts } : {}),
      ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}),
    };
    existingModels[aliasKey] = mergeRefreshedModelAlias(
      existing,
      remoteAlias,
      MANAGED_KIMI_MODEL_FIELDS,
    );
  }

  config.models = existingModels;
  config.defaultModel = modelKey;
  config.thinking = {
    ...config.thinking,
    enabled: options.thinking,
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
  };

  return { defaultModel: modelKey, defaultThinking: options.thinking };
}

export function removeOpenPlatformConfig(
  config: ManagedKimiConfigShape,
  platformId: string,
): void {
  delete config.providers[platformId];

  let removedDefault = false;
  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (!isRecord(model) || model['provider'] !== platformId) continue;
    delete existingModels[key];
    if (config.defaultModel === key) removedDefault = true;
  }
  config.models = existingModels;

  if (removedDefault) {
    config.defaultModel = undefined;
  }

  if (config['defaultProvider'] === platformId) {
    config['defaultProvider'] = undefined;
  }
}
