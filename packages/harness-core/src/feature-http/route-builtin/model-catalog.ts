import type { Request, Response } from 'express';

import {
  CatalogModels,
  ConfigRef,
  DEFAULT_MODEL_CONFIG_SECTION,
  MODELS_CONFIG_SECTION,
  ModelCatalogError,
  ModelDefaultsRef,
  PROVIDERS_CONFIG_SECTION,
  ProviderCatalogRef,
  matchCatalogBinding,
  omitUndefined,
  useInject,
  type CatalogModel,
  type CatalogModelConfig,
  type CatalogProviderInfo,
  type ConfigStore,
  type ModelCapability,
  type ModelsSection,
  type ProviderStore,
  type ProvidersSection,
} from '@moonshot-ai/agent-core';
import { useCollection } from '@moonshot-ai/agent-core/kernel/index';

import { useHttpRoute } from '../feature';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';

const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;
const PROVIDER_ID_MESSAGE = 'id must start with a letter or digit and may only contain letters, digits, "-", "_" and spaces';

const PROVIDER_WIRE_TYPES = ['kimi', 'openai', 'openai_responses', 'anthropic', 'google-genai', 'vertexai'] as const;

const PROVIDER_ACTIONS = ['refresh'] as const;
const MODEL_ACTIONS = ['set_default'] as const;

export interface ProviderView {
  readonly id: string;
  readonly type: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly has_api_key: boolean;
  readonly status: 'connected' | 'error' | 'unconfigured';
  readonly models?: readonly string[];
  readonly api_key?: string;
}

export interface ModelCatalogItemView {
  readonly provider: string;
  readonly model: string;
  readonly display_name?: string;
  readonly max_context_size: number;
  readonly capabilities?: readonly string[];
  readonly support_efforts?: readonly string[];
  readonly default_effort?: string;
}

interface ProviderModelInput {
  readonly model: string;
  readonly max_context_size: number;
  readonly display_name?: string;
  readonly capabilities?: readonly string[];
  readonly max_output_size?: number;
  readonly support_efforts?: readonly string[];
  readonly adaptive_thinking?: boolean;
}

interface ProviderForm {
  readonly id?: string;
  readonly newId?: string;
  readonly type: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly models: readonly ProviderModelInput[];
}

export function useModelCatalogRoutes(prefix: string): void {
  useHttpRoute({
    id: 'providers.list',
    method: 'GET',
    path: `${prefix}/providers`,
    handler: (request, response) => {
      const resolved = catalogFacades(request, response);
      if (resolved === undefined) return;
      const items = resolved.store
        .providers()
        .map((providerId) => providerView(providerId, resolved.config, resolved.store));
      sendOk(request, response, { items });
    },
  });

  useHttpRoute({
    id: 'providers.get',
    method: 'GET',
    path: `${prefix}/providers/:provider_id`,
    handler: (request, response) => {
      const providerId = param(request, 'provider_id');
      if (providerId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'provider_id is required');
        return;
      }
      const resolved = catalogFacades(request, response);
      if (resolved === undefined) return;
      if (!resolved.store.providers().includes(providerId)) {
        sendErr(
          request,
          response,
          ErrorCode.PROVIDER_NOT_FOUND,
          `provider ${providerId} does not exist`,
        );
        return;
      }
      const view = providerView(providerId, resolved.config, resolved.store);
      const stored = (resolved.config.get<ProvidersSection>(PROVIDERS_CONFIG_SECTION) ?? {})[providerId];
      const apiKey = stored?.apiKey;
      sendOk(request, response, {
        ...view,
        api_key: apiKey !== undefined && apiKey !== '' ? apiKey : undefined,
      });
    },
  });

  useHttpRoute({
    id: 'providers.create',
    method: 'POST',
    path: `${prefix}/providers`,
    handler: async (request, response) => {
      const resolved = catalogFacades(request, response);
      if (resolved === undefined) return;
      const form = readProviderForm(request.body, 'create');
      if ('error' in form) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, form.error);
        return;
      }
      const id = form.id;
      if (id === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, PROVIDER_ID_MESSAGE);
        return;
      }
      const providers = resolved.config.get<ProvidersSection>(PROVIDERS_CONFIG_SECTION) ?? {};
      if (providers[id] !== undefined) {
        sendErr(request, response, ErrorCode.PROVIDER_ALREADY_EXISTS, `provider ${id} already exists`);
        return;
      }
      const info = providerInfoFromForm(id, form);
      const aliases: Record<string, CatalogModelConfig> = {};
      for (const entry of form.models) {
        aliases[`${id}/${entry.model}`] = modelConfigFromInput(id, entry);
      }
      await resolved.config.set(PROVIDERS_CONFIG_SECTION, { [id]: info }, 'user');
      const currentModels = resolved.config.get<ModelsSection>(MODELS_CONFIG_SECTION) ?? {};
      await resolved.config.set(MODELS_CONFIG_SECTION, { ...currentModels, ...aliases }, 'user');
      const firstModel = form.models[0];
      const currentDefault = resolved.config.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
      if ((currentDefault === undefined || currentDefault.trim() === '') && firstModel !== undefined) {
        await resolved.config.set(
          DEFAULT_MODEL_CONFIG_SECTION,
          info.defaultModel ?? `${id}/${firstModel.model}`,
          'user',
        );
      }
      const nextModels = { ...currentModels, ...aliases };
      sendOk(
        request,
        response,
        buildProviderView(id, info, Object.keys(aliases), resolved.config, nextModels),
      );
    },
  });

  useHttpRoute({
    id: 'providers.replace',
    method: 'PUT',
    path: `${prefix}/providers/:provider_id`,
    handler: async (request, response) => {
      const providerId = param(request, 'provider_id');
      if (providerId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'provider_id is required');
        return;
      }
      const resolved = catalogFacades(request, response);
      if (resolved === undefined) return;
      const form = readProviderForm(request.body, 'replace');
      if ('error' in form) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, form.error);
        return;
      }
      const providers = resolved.config.get<ProvidersSection>(PROVIDERS_CONFIG_SECTION) ?? {};
      const target = providers[providerId];
      if (target === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.PROVIDER_NOT_FOUND,
          `provider ${providerId} does not exist`,
        );
        return;
      }
      if (target.oauth !== undefined) {
        sendErr(
          request,
          response,
          ErrorCode.PROVIDER_OAUTH_MANAGED,
          `provider ${providerId} is managed by OAuth login; use POST /oauth/logout instead`,
        );
        return;
      }
      const newId = form.newId ?? providerId;
      if (newId !== providerId && providers[newId] !== undefined) {
        sendErr(
          request,
          response,
          ErrorCode.PROVIDER_ALREADY_EXISTS,
          `provider ${newId} already exists`,
        );
        return;
      }
      const info = providerInfoFromForm(newId, form, target);
      const nextProviders = Object.fromEntries(
        Object.entries(providers).map(([key, value]) => [key === providerId ? newId : key, value]),
      );
      nextProviders[newId] = info;
      const models = resolved.config.get<ModelsSection>(MODELS_CONFIG_SECTION) ?? {};
      const newAliasKeys = new Set(form.models.map((entry) => `${newId}/${entry.model}`));
      const colliding = Object.entries(models)
        .filter(([, record]) => record.provider !== providerId)
        .map(([aliasId]) => aliasId)
        .filter((aliasId) => newAliasKeys.has(aliasId));
      if (colliding.length > 0) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          `model alias key already owned by another provider: ${colliding.join(', ')}`,
        );
        return;
      }
      await resolved.config.replace({ [PROVIDERS_CONFIG_SECTION]: nextProviders }, 'user');
      const previousAliasIds = new Set(
        Object.entries(models)
          .filter(([, record]) => record.provider === providerId)
          .map(([aliasId]) => aliasId),
      );
      const nextModels: Record<string, CatalogModelConfig> = Object.fromEntries(
        Object.entries(models).filter(([, record]) => record.provider !== providerId),
      );
      const previousByModel = new Map(
        Object.values(models)
          .filter((record) => record.provider === providerId)
          .map((record) => [record.model, record] as const),
      );
      for (const entry of form.models) {
        nextModels[`${newId}/${entry.model}`] = modelConfigFromInput(
          newId,
          entry,
          previousByModel.get(entry.model),
        );
      }
      await resolved.config.replace({ [MODELS_CONFIG_SECTION]: nextModels }, 'user');
      if (newId !== providerId) {
        const defaultModel = resolved.config.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
        if (defaultModel !== undefined && previousAliasIds.has(defaultModel)) {
          const renamedModel = models[defaultModel]?.model;
          const renamedAlias = renamedModel !== undefined ? `${newId}/${renamedModel}` : undefined;
          if (renamedAlias !== undefined && nextModels[renamedAlias] !== undefined) {
            await resolved.config.set(DEFAULT_MODEL_CONFIG_SECTION, renamedAlias, 'user');
          }
        }
      }
      sendOk(request, response, {
        provider: buildProviderView(
          newId,
          info,
          form.models.map((entry) => `${newId}/${entry.model}`),
          resolved.config,
          nextModels,
        ),
      });
    },
  });

  useHttpRoute({
    id: 'providers.delete',
    method: 'DELETE',
    path: `${prefix}/providers/:provider_id`,
    handler: async (request, response) => {
      const providerId = param(request, 'provider_id');
      if (providerId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'provider_id is required');
        return;
      }
      const resolved = catalogFacades(request, response);
      if (resolved === undefined) return;
      const providers = resolved.config.get<ProvidersSection>(PROVIDERS_CONFIG_SECTION) ?? {};
      const target = providers[providerId];
      if (target === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.PROVIDER_NOT_FOUND,
          `provider ${providerId} does not exist`,
        );
        return;
      }
      if (target.oauth !== undefined) {
        sendErr(
          request,
          response,
          ErrorCode.PROVIDER_OAUTH_MANAGED,
          `provider ${providerId} is managed by OAuth login; use POST /oauth/logout instead`,
        );
        return;
      }
      const restProviders = { ...providers };
      delete restProviders[providerId];
      await resolved.config.replace({ [PROVIDERS_CONFIG_SECTION]: restProviders }, 'user');
      const models = resolved.config.get<ModelsSection>(MODELS_CONFIG_SECTION) ?? {};
      const restModels = Object.fromEntries(
        Object.entries(models).filter(([, record]) => record.provider !== providerId),
      );
      if (Object.keys(restModels).length !== Object.keys(models).length) {
        await resolved.config.replace({ [MODELS_CONFIG_SECTION]: restModels }, 'user');
      }
      response.status(204).end();
    },
  });

  useHttpRoute({
    id: 'providers.action',
    method: 'POST',
    path: `${prefix}/providers/:tail`,
    handler: async (request, response) => {
      const tail = param(request, 'tail');
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'provider_id is required');
        return;
      }
      const parsed = parseActionSuffix({ tail, allowedActions: PROVIDER_ACTIONS, resourceLabel: 'provider' });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
        );
        return;
      }
      const resolved = catalogFacades(request, response);
      if (resolved === undefined) return;
      if (!resolved.store.providers().includes(parsed.id)) {
        sendErr(
          request,
          response,
          ErrorCode.PROVIDER_NOT_FOUND,
          `provider ${parsed.id} does not exist`,
        );
        return;
      }
      resolved.store.refresh(parsed.id);
      sendOk(request, response, { changed: [], unchanged: [parsed.id], failed: [] });
    },
  });

  useHttpRoute({
    id: 'models.list',
    method: 'GET',
    path: `${prefix}/models`,
    handler: (request, response) => {
      const resolved = catalogFacades(request, response);
      if (resolved === undefined) return;
      const items = resolved.store
        .providers()
        .flatMap((providerId) =>
          resolved.store.models(providerId).map((model) => modelCatalogItemView(providerId, model)),
        );
      sendOk(request, response, { items });
    },
  });

  useHttpRoute({
    id: 'models.action',
    method: 'POST',
    path: `${prefix}/models/:tail`,
    handler: async (request, response) => {
      const tail = param(request, 'tail');
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'model id is required');
        return;
      }
      const parsed = parseActionSuffix({ tail, allowedActions: MODEL_ACTIONS, resourceLabel: 'model' });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
        );
        return;
      }
      const resolved = catalogFacades(request, response);
      if (resolved === undefined) return;
      const bindings = useCollection(CatalogModels);
      const defaults = useInject(ModelDefaultsRef).value;
      if (defaults === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.PROVIDER_CATALOG_UNAVAILABLE,
          'model catalog is unavailable (provider-catalog feature is not installed)',
        );
        return;
      }
      try {
        await defaults.setDefaultModel(parsed.id);
      } catch (error) {
        if (error instanceof ModelCatalogError) {
          if (error.code === 'model.unknown_alias') {
            sendErr(request, response, ErrorCode.MODEL_NOT_FOUND, error.message);
            return;
          }
          sendErr(request, response, ErrorCode.CONFIG_UNAVAILABLE, error.message);
          return;
        }
        throw error;
      }
      const binding = matchCatalogBinding(parsed.id, bindings.value);
      const slash = parsed.id.indexOf('/');
      sendOk(request, response, {
        default_model: parsed.id,
        model:
          binding === undefined
            ? {
                provider: slash > 0 ? parsed.id.slice(0, slash) : '',
                model: slash > 0 ? parsed.id.slice(slash + 1) : parsed.id,
                max_context_size: 0,
              }
            : modelCatalogItemView(binding.providerId, binding.model),
      });
    },
  });
}

function catalogFacades(
  request: Request,
  response: Response,
): { readonly config: ConfigStore; readonly store: ProviderStore } | undefined {
  const config = useInject(ConfigRef).value;
  if (config === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.CONFIG_UNAVAILABLE,
      'config is unavailable (config feature is not installed)',
    );
    return undefined;
  }
  const store = useInject(ProviderCatalogRef).value;
  if (store === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.PROVIDER_CATALOG_UNAVAILABLE,
      'model catalog is unavailable (provider-catalog feature is not installed)',
    );
    return undefined;
  }
  return { config, store };
}

function readProviderForm(body: unknown, mode: 'create' | 'replace'): ProviderForm | { readonly error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be an object' };
  }
  const record = body as { [key: string]: unknown };
  const form: {
    id?: string;
    newId?: string;
    type?: string;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    models?: readonly ProviderModelInput[];
  } = {};
  if (mode === 'create') {
    if (typeof record['id'] !== 'string' || !PROVIDER_ID_PATTERN.test(record['id'])) {
      return { error: PROVIDER_ID_MESSAGE };
    }
    form.id = record['id'];
  } else if (record['new_id'] !== undefined) {
    if (typeof record['new_id'] !== 'string' || !PROVIDER_ID_PATTERN.test(record['new_id'])) {
      return { error: PROVIDER_ID_MESSAGE };
    }
    form.newId = record['new_id'];
  }
  if (typeof record['type'] !== 'string' || !(PROVIDER_WIRE_TYPES as readonly string[]).includes(record['type'])) {
    return { error: `type must be one of ${PROVIDER_WIRE_TYPES.join(', ')}` };
  }
  form.type = record['type'];
  if (record['api_key'] !== undefined) {
    if (typeof record['api_key'] !== 'string') return { error: 'api_key must be a string' };
    form.apiKey = record['api_key'];
  }
  if (record['base_url'] !== undefined) {
    if (typeof record['base_url'] !== 'string') return { error: 'base_url must be a string' };
    if (record['base_url'].includes('${')) {
      return { error: 'base_url must not contain an environment variable placeholder' };
    }
    form.baseUrl = record['base_url'].trim();
  }
  if (record['default_model'] !== undefined) {
    if (typeof record['default_model'] !== 'string' || record['default_model'].length === 0) {
      return { error: 'default_model must be a non-empty string' };
    }
    form.defaultModel = record['default_model'];
  }
  const models = record['models'];
  if (!Array.isArray(models) || models.length === 0) {
    return { error: 'models must contain at least one entry' };
  }
  const parsed: ProviderModelInput[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'models entries must be objects' };
    }
    const item = entry as { [key: string]: unknown };
    if (typeof item['model'] !== 'string' || item['model'].length === 0) {
      return { error: 'models[].model must be a non-empty string' };
    }
    if (seen.has(item['model'])) {
      return { error: `duplicate model: ${item['model']}` };
    }
    seen.add(item['model']);
    const maxContextSize = item['max_context_size'];
    if (typeof maxContextSize !== 'number' || !Number.isInteger(maxContextSize) || maxContextSize < 1) {
      return { error: 'models[].max_context_size must be a positive integer' };
    }
    if (item['display_name'] !== undefined && typeof item['display_name'] !== 'string') {
      return { error: 'models[].display_name must be a string' };
    }
    if (
      item['capabilities'] !== undefined &&
      (!Array.isArray(item['capabilities']) || item['capabilities'].some((c) => typeof c !== 'string'))
    ) {
      return { error: 'models[].capabilities must be an array of strings' };
    }
    const maxOutputSize = item['max_output_size'];
    if (maxOutputSize !== undefined && (typeof maxOutputSize !== 'number' || !Number.isInteger(maxOutputSize) || maxOutputSize < 1)) {
      return { error: 'models[].max_output_size must be a positive integer' };
    }
    if (
      item['support_efforts'] !== undefined &&
      (!Array.isArray(item['support_efforts']) || item['support_efforts'].some((c) => typeof c !== 'string' || c.length === 0))
    ) {
      return { error: 'models[].support_efforts must be an array of strings' };
    }
    if (item['adaptive_thinking'] !== undefined && typeof item['adaptive_thinking'] !== 'boolean') {
      return { error: 'models[].adaptive_thinking must be a boolean' };
    }
    parsed.push({
      model: item['model'],
      max_context_size: maxContextSize,
      display_name: typeof item['display_name'] === 'string' ? item['display_name'] : undefined,
      capabilities: Array.isArray(item['capabilities']) ? (item['capabilities'] as string[]) : undefined,
      max_output_size: typeof maxOutputSize === 'number' ? maxOutputSize : undefined,
      support_efforts: Array.isArray(item['support_efforts']) ? (item['support_efforts'] as string[]) : undefined,
      adaptive_thinking: typeof item['adaptive_thinking'] === 'boolean' ? item['adaptive_thinking'] : undefined,
    });
  }
  if (form.defaultModel !== undefined && !parsed.some((entry) => entry.model === form.defaultModel)) {
    return { error: 'default_model must be one of models[].model' };
  }
  return {
    id: form.id,
    newId: form.newId,
    type: form.type,
    apiKey: form.apiKey,
    baseUrl: form.baseUrl,
    defaultModel: form.defaultModel,
    models: parsed,
  };
}

function providerInfoFromForm(
  id: string,
  form: ProviderForm,
  target?: CatalogProviderInfo,
): CatalogProviderInfo {
  return omitUndefined({
    ...target,
    type: form.type,
    apiKey: form.apiKey ?? target?.apiKey,
    baseUrl: form.baseUrl,
    defaultModel: form.defaultModel !== undefined ? `${id}/${form.defaultModel}` : undefined,
  }) as CatalogProviderInfo;
}

function modelConfigFromInput(
  providerId: string,
  entry: ProviderModelInput,
  previous?: CatalogModelConfig,
): CatalogModelConfig {
  return omitUndefined({
    ...previous,
    provider: providerId,
    model: entry.model,
    maxContextSize: entry.max_context_size,
    displayName: entry.display_name,
    capability: mapCapabilities(entry.capabilities),
    maxOutputSize: entry.max_output_size,
    supportEfforts: entry.support_efforts === undefined ? undefined : [...entry.support_efforts],
    adaptiveThinking: entry.adaptive_thinking,
    alwaysThinking: hasDeclaredCapability(entry.capabilities, 'always_thinking') ? true : undefined,
  }) as CatalogModelConfig;
}

function hasDeclaredCapability(capabilities: readonly string[] | undefined, name: string): boolean {
  if (capabilities === undefined) return false;
  return capabilities.some((capability) => capability.trim().toLowerCase() === name);
}

function mapCapabilities(capabilities: readonly string[] | undefined): ModelCapability | undefined {
  if (capabilities === undefined) return undefined;
  return {
    image_in: hasDeclaredCapability(capabilities, 'image_in'),
    video_in: hasDeclaredCapability(capabilities, 'video_in'),
    audio_in: hasDeclaredCapability(capabilities, 'audio_in'),
    thinking: hasDeclaredCapability(capabilities, 'thinking') || hasDeclaredCapability(capabilities, 'always_thinking'),
    tool_use: hasDeclaredCapability(capabilities, 'tool_use'),
    dynamically_loaded_tools: hasDeclaredCapability(capabilities, 'dynamically_loaded_tools') ? true : undefined,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasApiKey(info: CatalogProviderInfo | undefined, config: ConfigStore): boolean {
  if (info === undefined) return false;
  if (nonEmpty(info.apiKey) !== undefined) return true;
  const envName = info.env?.['apiKey'];
  return envName !== undefined && nonEmpty(config.env(envName)) !== undefined;
}

function buildProviderView(
  providerId: string,
  info: CatalogProviderInfo | undefined,
  aliasIds: readonly string[],
  config: ConfigStore,
  modelsSection: Readonly<Record<string, CatalogModelConfig>>,
): ProviderView {
  const globalDefault = config.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
  const defaultModel =
    info?.defaultModel ??
    (globalDefault !== undefined && modelsSection[globalDefault]?.provider === providerId
      ? globalDefault
      : undefined);
  const hasKey = hasApiKey(info, config);
  return {
    id: providerId,
    type: info?.type ?? 'openai',
    base_url: info?.baseUrl,
    default_model: defaultModel,
    has_api_key: hasKey,
    status: hasKey || info?.oauth !== undefined ? 'connected' : 'unconfigured',
    models: aliasIds,
  };
}

function providerView(providerId: string, config: ConfigStore, store: ProviderStore): ProviderView {
  const info = store.providerInfo(providerId);
  const aliasIds = store.models(providerId).map((model) => model.alias);
  const modelsSection = config.get<ModelsSection>(MODELS_CONFIG_SECTION) ?? {};
  return buildProviderView(providerId, info, aliasIds, config, modelsSection);
}

function capabilityStrings(model: CatalogModel): readonly string[] | undefined {
  const capability = model.capability;
  const out: string[] = [];
  if (capability.image_in) out.push('image_in');
  if (capability.video_in) out.push('video_in');
  if (capability.audio_in) out.push('audio_in');
  if (capability.thinking) out.push('thinking');
  if (capability.tool_use) out.push('tool_use');
  if (capability.dynamically_loaded_tools === true) out.push('dynamically_loaded_tools');
  if (model.alwaysThinking === true) out.push('always_thinking');
  return out.length === 0 ? undefined : out;
}

function modelCatalogItemView(providerId: string, model: CatalogModel): ModelCatalogItemView {
  return {
    provider: providerId,
    model: model.alias,
    display_name: model.displayName ?? model.name ?? model.model,
    max_context_size: model.maxContextSize ?? 0,
    capabilities: capabilityStrings(model),
    support_efforts: model.supportEfforts === undefined ? undefined : [...model.supportEfforts],
    default_effort: model.defaultEffort,
  };
}
