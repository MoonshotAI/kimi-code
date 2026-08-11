// packages/app-core/src/lib/providerForm.ts
// Logic for the settings Providers panel: the daemon's wire protocol types,
// client-side validation (mirrors the server zod schema, design §4.1), request
// building for the add (POST) and edit (PUT) paths, and the managed-OAuth
// provider check.

import type { AddProviderInput, AddProviderModelInput, AppProvider, UpdateProviderInput } from '../api/types';

/** Wire protocols the daemon accepts for a provider (agent-core config schema). */
export const PROVIDER_TYPES = [
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
] as const;

/** One editable model row; maxContextSize stays a string until submit. */
export interface ModelRow {
  model: string;
  maxContextSize: string;
  displayName: string;
  /** Full capabilities array, including values unknown to the toggles (e.g.
      always_thinking) — they round-trip untouched through the form. */
  capabilities: string[];
  supportEfforts: string[];
  /** Tri-state on purpose: undefined must stay undefined (core infers from the
      model name); only newly added rows default to true. Not shown in the UI. */
  adaptiveThinking?: boolean;
}

export interface ProviderFormState {
  id: string;
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

/**
 * Model rows for an existing provider, built from the config's model records
 * (GET /config → models section). The record's `model` field is the bare
 * remote model id — never the `<prefix>/<model>` catalog alias (prefixes are
 * an alias-key scheme and may not even match the provider id). May return an
 * empty array when the provider has no records.
 */
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

/** Validation failures, rendered via the providers.error.* i18n keys. */
export type ProviderFormError =
  | 'idRequired'
  | 'idInvalid'
  | 'apiKeyRequired'
  | 'baseUrlRequired'
  | 'modelRequired'
  | 'contextSizeRequired'
  | 'contextSizeInvalid';

// Server schema (design §4.1): Unicode letters/digits + "-", "_", spaces.
export const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;

/**
 * Validate the provider form. Both the add and the edit path validate the id
 * (it stays editable there — renames go through PUT new_id). `requireApiKey`
 * / `requireBaseUrl` are enforced only on the add path: on edit a blank API
 * key means keep-or-clear (decided by whether the stored key was loaded) and
 * a blank base URL means unset, so neither may block saving.
 */
export function validateProviderForm(
  state: ProviderFormState,
  opts: { requireApiKey?: boolean; requireBaseUrl?: boolean } = {},
): ProviderFormError | null {
  const id = state.id.trim();
  if (id === '') return 'idRequired';
  if (!PROVIDER_ID_PATTERN.test(id)) return 'idInvalid';
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

/** Trim rows, parse the context size, and drop blank display names. Empty
 *  capability/effort lists are OMITTED (not persisted as `[]`): a missing key
 *  and an empty array mean different things at runtime (inferred defaults vs
 *  explicitly none). Unknown capability members ride along untouched. */
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

/** Map the validated form to the add-provider request: trims strings and drops
 *  blank optionals. */
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

/**
 * Map the validated form to the update-provider request (PUT replace
 * semantics). A blank API-key input normally means "keep the stored key", so
 * the field is omitted; when the form had the stored key loaded into it
 * (`includeBlankApiKey`), the input is authoritative and a blank means clear
 * (sent as '' — the wire tri-state). The panel has no default-model field:
 * the provider's CONFIGURED default (`existingDefaultModel`, the raw config
 * value in `<prefix>/<model>` alias form — never the catalog item's
 * materialized `default_model`, which falls back to the GLOBAL default and
 * would be wrongly persisted as provider-level) is preserved while it still
 * points at a listed model, otherwise it is dropped and the server clears it.
 * The wire wants the BARE model name (the server rebuilds the alias itself),
 * so the alias prefix — everything up to the first "/" — is stripped; a bare
 * model id may itself contain "/" (gateway catalogs like openrouter).
 */
export function buildUpdateProviderInput(
  state: ProviderFormState,
  existing?: AppProvider,
  opts?: { includeBlankApiKey?: boolean; existingDefaultModel?: string },
): UpdateProviderInput {
  const models = buildModels(state.models);
  const newId = state.id.trim();
  const apiKey = state.apiKey.trim();
  const baseUrl = state.baseUrl.trim();
  const configuredDefault = opts?.existingDefaultModel?.trim() ?? '';
  const bareDefault =
    configuredDefault.indexOf('/') >= 0
      ? configuredDefault.slice(configuredDefault.indexOf('/') + 1)
      : configuredDefault;
  return {
    ...(existing !== undefined && newId !== '' && newId !== existing.id ? { newId } : {}),
    type: state.type,
    models,
    ...(apiKey === '' && opts?.includeBlankApiKey !== true ? {} : { apiKey }),
    ...(baseUrl === '' ? {} : { baseUrl }),
    ...(bareDefault !== '' && models.some((m) => m.model === bareDefault)
      ? { defaultModel: bareDefault }
      : {}),
  };
}

/** The managed OAuth login materializes as this fixed provider id + type
 *  (core KIMI_CODE_PROVIDER_NAME); the catalog wire carries no oauth flag, so
 *  the stable id is the reliable tell. The server rejects deleting it too. */
export function isManagedOAuthProvider(provider: { id: string; type: string }): boolean {
  return provider.id === 'managed:kimi-code' && provider.type === 'kimi';
}
