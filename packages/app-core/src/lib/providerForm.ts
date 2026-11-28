
import type { AddProviderInput, AddProviderModelInput, AppCatalogModel, AppProvider, UpdateProviderInput } from '../api/types';
import { MANAGED_KIMI_CODE_PROVIDER_ID } from '../api/types';

export const PROVIDER_TYPES = [
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
] as const;

export interface ModelRow {
  model: string;
  maxContextSize: string;
  displayName: string;
  capabilities: string[];
  supportEfforts: string[];
  adaptiveThinking?: boolean;
}

export interface ProviderFormState {
  id: string;
  displayName?: string;
  type: string;
  apiKey: string;
  baseUrl: string;
  models: ModelRow[];
}

export function emptyModelRow(): ModelRow {
  return {
    model: '',
    maxContextSize: '',
    displayName: '',
    capabilities: ['tool_use', 'thinking'],
    supportEfforts: [],
    adaptiveThinking: true,
  };
}

export function providerModelRows(
  provider: AppProvider,
  configModels: Record<string, unknown> | undefined,
): ModelRow[] {
  const rows: ModelRow[] = [];
  for (const raw of Object.values(configModels ?? {})) {
    if (raw === null || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    if (record['provider'] !== provider.id) continue;
    rows.push({
      model: typeof record['model'] === 'string' ? record['model'] : '',
      maxContextSize:
        typeof record['maxContextSize'] === 'number' ? String(record['maxContextSize']) : '',
      displayName: typeof record['displayName'] === 'string' ? record['displayName'] : '',
      capabilities: Array.isArray(record['capabilities'])
        ? record['capabilities'].filter((c): c is string => typeof c === 'string')
        : [],
      supportEfforts: Array.isArray(record['supportEfforts'])
        ? record['supportEfforts'].filter((e): e is string => typeof e === 'string')
        : [],
      ...(typeof record['adaptiveThinking'] === 'boolean'
        ? { adaptiveThinking: record['adaptiveThinking'] }
        : {}),
    });
  }
  return rows;
}

export type ProviderFormError =
  | 'idRequired'
  | 'idInvalid'
  | 'apiKeyRequired'
  | 'baseUrlRequired'
  | 'modelRequired'
  | 'contextSizeRequired'
  | 'contextSizeInvalid';

export const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;

export function adaptBaseUrlForType(baseUrl: string, type: string): string {
  return type === 'anthropic' ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl;
}

export function catalogModelToRow(model: AppCatalogModel): ModelRow {
  return {
    model: model.id,
    maxContextSize: model.maxContextSize > 0 ? String(model.maxContextSize) : '',
    displayName: model.name ?? '',
    capabilities: [...(model.capabilities ?? ['tool_use', 'thinking'])],
    supportEfforts: [],
    adaptiveThinking: true,
  };
}

export function validateProviderForm(
  state: ProviderFormState,
  opts: { requireApiKey?: boolean; requireBaseUrl?: boolean; renaming?: boolean } = {},
): ProviderFormError | null {
  if (opts.renaming === true) {
    if ((state.displayName ?? '').trim() === '') return 'idRequired';
  } else {
    const id = state.id.trim();
    if (id === '') return 'idRequired';
    if (!PROVIDER_ID_PATTERN.test(id)) return 'idInvalid';
  }
  if (opts.requireApiKey === true && state.apiKey.trim() === '') return 'apiKeyRequired';
  if (opts.requireBaseUrl === true && state.baseUrl.trim() === '') return 'baseUrlRequired';
  if (state.models.length === 0) return 'modelRequired';
  for (const row of state.models) {
    if (row.model.trim() === '') return 'modelRequired';
    const size = row.maxContextSize.trim();
    if (size === '') return 'contextSizeRequired';
    if (!/^\d+$/.test(size) || Number(size) < 1) return 'contextSizeInvalid';
  }
  return null;
}

function buildModels(rows: ModelRow[]): AddProviderModelInput[] {
  return rows.map((row) => {
    const displayName = row.displayName.trim();
    return {
      model: row.model.trim(),
      maxContextSize: Number(row.maxContextSize.trim()),
      ...(row.capabilities.length > 0 ? { capabilities: [...row.capabilities] } : {}),
      ...(row.supportEfforts.length > 0 ? { supportEfforts: [...row.supportEfforts] } : {}),
      ...(row.adaptiveThinking !== undefined ? { adaptiveThinking: row.adaptiveThinking } : {}),
      ...(displayName === '' ? {} : { displayName }),
    };
  });
}

export function buildAddProviderInput(state: ProviderFormState): AddProviderInput {
  const apiKey = state.apiKey.trim();
  const baseUrl = state.baseUrl.trim();
  return {
    id: state.id.trim(),
    type: state.type,
    models: buildModels(state.models),
    ...(apiKey === '' ? {} : { apiKey }),
    ...(baseUrl === '' ? {} : { baseUrl }),
  };
}

export function buildUpdateProviderInput(
  state: ProviderFormState,
  existing?: AppProvider,
  opts?: { includeBlankApiKey?: boolean; existingDefaultModel?: string },
): UpdateProviderInput {
  const models = buildModels(state.models);
  const displayName = (state.displayName ?? '').trim();
  const apiKey = state.apiKey.trim();
  const baseUrl = state.baseUrl.trim();
  const configuredDefault = opts?.existingDefaultModel?.trim() ?? '';
  const bareDefault =
    configuredDefault.indexOf('/') >= 0
      ? configuredDefault.slice(configuredDefault.indexOf('/') + 1)
      : configuredDefault;
  return {
    ...(existing !== undefined && displayName !== ''
      ? { displayName: displayName === existing.id ? '' : displayName }
      : {}),
    type: state.type,
    models,
    ...(apiKey === '' && opts?.includeBlankApiKey !== true ? {} : { apiKey }),
    ...(baseUrl === '' ? {} : { baseUrl }),
    ...(bareDefault !== '' && models.some((m) => m.model === bareDefault)
      ? { defaultModel: bareDefault }
      : {}),
  };
}

export function isManagedOAuthProvider(provider: { id: string; type: string }): boolean {
  return provider.id === MANAGED_KIMI_CODE_PROVIDER_ID && provider.type === 'kimi';
}
