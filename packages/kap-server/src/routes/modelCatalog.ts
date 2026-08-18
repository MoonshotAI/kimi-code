import {
  IConfigService,
  IKosongConfigService,
  IModelCatalog,
  IOAuthService,
  IProviderDiscoveryService,
  IModelsDevImportService,
  isError2,
  ModelsDevImportErrors,
  type ModelRecord,
  type ModelsSection,
  type ProviderConfig,
  type ProvidersSection,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { setDefaultModelResponseSchema } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import { refreshProviderModelsResponseSchema } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import {
  SECONDARY_MODEL_SECTION,
  cascadeSubagentModelPool,
  type SecondaryModelConfig,
} from '@moonshot-ai/agent-core-v2/session/subagent/configSection';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  createProviderRequestSchema,
  createProviderResponseSchema,
  getCatalogProviderResponseSchema,
  getProviderResponseSchema,
  importCatalogProviderResponseSchema,
  importCustomRegistryResponseSchema,
  listCatalogProvidersResponseSchema,
  listModelsResponseSchema,
  listProvidersResponseSchema,
  providerCollectionActionBodySchema,
  replaceProviderRequestSchema,
  replaceProviderResponseSchema,
  type ProviderCollectionActionBody,
} from '../protocol/rest-modelCatalog';
import { parseActionSuffix } from './action-suffix';

interface ModelCatalogRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

interface StatusReply {
  code(status: number): StatusReply;
  send(payload?: unknown): unknown;
}

const providerIdParamSchema = z.object({
  provider_id: z.string().min(1),
});

const modelActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const providerActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const providerCollectionActionParamSchema = z.object({
  action: z.string().min(1),
});

const catalogIdParamSchema = z.object({
  catalog_id: z.string().min(1),
});

async function loadCatalog(core: Scope): Promise<IModelCatalog> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IModelCatalog);
}

async function loadConfig(core: Scope): Promise<IConfigService> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  await core.accessor.get(IKosongConfigService).ready;
  return config;
}

async function loadDiscovery(core: Scope): Promise<IProviderDiscoveryService> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IProviderDiscoveryService);
}

async function loadOAuth(core: Scope): Promise<IOAuthService> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IOAuthService);
}

let providerWriteChain: Promise<unknown> = Promise.resolve();

function enqueueProviderWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = providerWriteChain.then(task, task);
  providerWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function seedDefaultModelWhenUnset(config: IConfigService, alias: string): Promise<void> {
  const current = config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
  if (current !== undefined && current.trim() !== '') return;
  await config.replace(DEFAULT_MODEL_SECTION, alias);
}

export function registerModelCatalogRoutes(app: ModelCatalogRouteHost, core: Scope): void {
  const listModelsRoute = defineRoute(
    {
      method: 'GET',
      path: '/models',
      success: { data: listModelsResponseSchema },
      description: 'List configured model aliases',
      tags: ['models'],
    },
    async (req, reply) => {
      const items = await (await loadCatalog(core)).listModels();
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listModelsRoute.path,
    listModelsRoute.options,
    listModelsRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const setDefaultModelRoute = defineRoute(
    {
      method: 'POST',
      path: '/models/{tail}',
      params: modelActionTailParamSchema,
      success: { data: setDefaultModelResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.MODEL_NOT_FOUND]: {},
      },
      description: 'Set the global default model alias',
      tags: ['models'],
      operationId: 'setDefaultModel',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['set_default'] as const,
          resourceLabel: 'model',
        });
        if (parsed.kind !== 'action') {
          const message =
            parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = await (await loadCatalog(core)).setDefaultModel(parsed.id);
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        if (sendMappedError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.post(
    setDefaultModelRoute.path,
    setDefaultModelRoute.options,
    setDefaultModelRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const listProvidersRoute = defineRoute(
    {
      method: 'GET',
      path: '/providers',
      success: { data: listProvidersResponseSchema },
      description: 'List configured providers',
      tags: ['providers'],
    },
    async (req, reply) => {
      const items = await (await loadCatalog(core)).listProviders();
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listProvidersRoute.path,
    listProvidersRoute.options,
    listProvidersRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const createProviderRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers',
      body: createProviderRequestSchema,
      success: { data: createProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_ALREADY_EXISTS]: {},
      },
      description:
        'Create a provider manually (type + credentials + model list). When no global default_model is configured (fresh setup), it is seeded with the new provider default (or first) model; an existing default is never modified.',
      tags: ['providers'],
      operationId: 'createProvider',
    },
    async (req, reply) => {
      await enqueueProviderWrite(async () => {
        const config = await loadConfig(core);
        const { id } = req.body;
        const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
        if (providers[id] !== undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_ALREADY_EXISTS,
              `provider ${id} already exists`,
              req.id,
            ),
          );
          return;
        }

        const provider: ProviderConfig = { type: req.body.type };
        if (req.body.api_key !== undefined) provider.apiKey = req.body.api_key;
        if (req.body.base_url !== undefined) provider.baseUrl = req.body.base_url;
        if (req.body.default_model !== undefined) {
          provider.defaultModel = `${id}/${req.body.default_model}`;
        }
        await config.set(PROVIDERS_SECTION, { [id]: provider });

        const aliases: Record<string, ModelRecord> = {};
        for (const entry of req.body.models) {
          const alias: ModelRecord = {
            provider: id,
            model: entry.model,
            maxContextSize: entry.max_context_size,
          };
          if (entry.display_name !== undefined) alias.displayName = entry.display_name;
          if (entry.capabilities !== undefined) alias.capabilities = [...entry.capabilities];
          if (entry.max_output_size !== undefined) alias.maxOutputSize = entry.max_output_size;
          if (entry.support_efforts !== undefined)
            alias.supportEfforts = [...entry.support_efforts];
          if (entry.adaptive_thinking !== undefined)
            alias.adaptiveThinking = entry.adaptive_thinking;
          aliases[`${id}/${entry.model}`] = alias;
        }
        await config.set(MODELS_SECTION, aliases);

        const firstModel = req.body.models[0];
        if (firstModel !== undefined) {
          await seedDefaultModelWhenUnset(
            config,
            provider.defaultModel ?? `${id}/${firstModel.model}`,
          );
        }

        const created = await core.accessor.get(IModelCatalog).getProvider(id);
        (reply as unknown as StatusReply).code(201).send(okEnvelope(created, req.id));
      });
    },
  );
  app.post(
    createProviderRoute.path,
    createProviderRoute.options,
    createProviderRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const replaceProviderRoute = defineRoute(
    {
      method: 'PUT',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      body: replaceProviderRequestSchema,
      success: { data: replaceProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_OAUTH_MANAGED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
        [ErrorCode.PROVIDER_ALREADY_EXISTS]: {},
      },
      description:
        'Replace a provider in one save (type + base_url + model list), optionally renaming it via `new_id` (the providers key, model aliases, default_provider and a default_model pointing at an old alias all migrate). `api_key` is tri-state: omitted keeps the stored key, "" clears it, any other value replaces it. The provider\'s model aliases are rebuilt from `models` — aliases no longer listed disappear from config.toml, other providers\' aliases are untouched. Beyond the rename migration, the global default pointers are never modified. Answers 200 with `{provider}`. OAuth-managed providers are rejected: log out via /oauth/logout instead.',
      tags: ['providers'],
      operationId: 'replaceProvider',
    },
    async (req, reply) => {
      await enqueueProviderWrite(async () => {
        const config = await loadConfig(core);
        const { provider_id } = req.params;
        const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
        const target = providers[provider_id];
        if (target === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_NOT_FOUND,
              `provider ${provider_id} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if (target.oauth !== undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_OAUTH_MANAGED,
              `provider ${provider_id} is managed by OAuth login; use POST /oauth/logout instead`,
              req.id,
            ),
          );
          return;
        }

        const newId = req.body.new_id ?? provider_id;
        if (newId !== provider_id && providers[newId] !== undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_ALREADY_EXISTS,
              `provider ${newId} already exists`,
              req.id,
            ),
          );
          return;
        }

        const provider: ProviderConfig = { ...target, type: req.body.type };
        provider.apiKey = req.body.api_key ?? target.apiKey;
        provider.baseUrl = req.body.base_url;
        provider.defaultModel =
          req.body.default_model !== undefined
            ?
              `${newId}/${req.body.default_model}`
            : undefined;
        const nextProviders = Object.fromEntries(
          Object.entries(providers).map(([key, value]) => [
            key === provider_id ? newId : key,
            value,
          ]),
        );
        nextProviders[newId] = provider;

        const models = config.inspect<ModelsSection>(MODELS_SECTION).userValue ?? {};
        const newAliasKeys = new Set(req.body.models.map((entry) => `${newId}/${entry.model}`));
        const colliding = Object.entries(models)
          .filter(([, record]) => record.provider !== provider_id)
          .map(([aliasId]) => aliasId)
          .filter((aliasId) => newAliasKeys.has(aliasId));
        if (colliding.length > 0) {
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `model alias key already owned by another provider: ${colliding.join(', ')}`,
              req.id,
            ),
          );
          return;
        }

        await config.replace(PROVIDERS_SECTION, nextProviders);

        const previousAliasIds = new Set(
          Object.entries(models)
            .filter(([, record]) => record.provider === provider_id)
            .map(([aliasId]) => aliasId),
        );
        const nextModels = Object.fromEntries(
          Object.entries(models).filter(([, record]) => record.provider !== provider_id),
        );
        const previousByModel = new Map(
          Object.values(models)
            .filter((record) => record.provider === provider_id && record.model !== undefined)
            .map((record) => [record.model as string, record] as const),
        );
        for (const entry of req.body.models) {
          const alias: ModelRecord = {
            ...previousByModel.get(entry.model),
            provider: newId,
            model: entry.model,
            maxContextSize: entry.max_context_size,
          };
          alias.displayName = entry.display_name !== undefined ? entry.display_name : undefined;
          alias.capabilities =
            entry.capabilities !== undefined ? [...entry.capabilities] : undefined;
          alias.maxOutputSize = entry.max_output_size !== undefined ? entry.max_output_size : undefined;
          alias.supportEfforts =
            entry.support_efforts !== undefined ? [...entry.support_efforts] : undefined;
          alias.adaptiveThinking =
            entry.adaptive_thinking !== undefined ? entry.adaptive_thinking : undefined;
          nextModels[`${newId}/${entry.model}`] = alias;
        }
        await config.replace(MODELS_SECTION, nextModels);

        if (newId !== provider_id) {
          const defaultProvider = config.inspect<string>(DEFAULT_PROVIDER_SECTION).userValue;
          if (defaultProvider === provider_id) {
            await config.replace(DEFAULT_PROVIDER_SECTION, newId);
          }
          const defaultModel = config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
          if (defaultModel !== undefined && previousAliasIds.has(defaultModel)) {
            const renamedModel = models[defaultModel]?.model;
            const renamedAlias = renamedModel !== undefined ? `${newId}/${renamedModel}` : undefined;
            if (renamedAlias !== undefined && nextModels[renamedAlias] !== undefined) {
              await config.replace(DEFAULT_MODEL_SECTION, renamedAlias);
            }
          }
        }

        const renamedAliases = new Map<string, string>();
        if (newId !== provider_id) {
          for (const oldAlias of previousAliasIds) {
            const bare = models[oldAlias]?.model;
            const renamed = bare === undefined ? undefined : `${newId}/${bare}`;
            if (renamed !== undefined && nextModels[renamed] !== undefined) {
              renamedAliases.set(oldAlias, renamed);
            }
          }
        }
        const secondaryModel = config.inspect<SecondaryModelConfig>(
          SECONDARY_MODEL_SECTION,
        ).userValue;
        const cascadedPool = cascadeSubagentModelPool(secondaryModel, nextModels, renamedAliases);
        if (cascadedPool !== undefined) {
          await config.replace(SECONDARY_MODEL_SECTION, cascadedPool);
        }

        const saved = await core.accessor.get(IModelCatalog).getProvider(newId);
        reply.send(okEnvelope({ provider: saved }, req.id));
      });
    },
  );
  app.put(
    replaceProviderRoute.path,
    replaceProviderRoute.options,
    replaceProviderRoute.handler as Parameters<ModelCatalogRouteHost['put']>[2],
  );

  const refreshProvidersRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers:action',
      params: providerCollectionActionParamSchema,
      body: providerCollectionActionBodySchema.optional(),
      success: {
        data: z.union([
          refreshProviderModelsResponseSchema,
          importCatalogProviderResponseSchema,
          importCustomRegistryResponseSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.CATALOG_IMPORT_INVALID]: {},
        [ErrorCode.REGISTRY_IMPORT_INVALID]: {},
        [ErrorCode.PROVIDER_OAUTH_MANAGED]: {},
        [ErrorCode.CATALOG_ENTRY_NOT_FOUND]: {},
        [ErrorCode.CATALOG_UNAVAILABLE]: {},
      },
      description:
        'Provider collection actions. Use `:refresh` for all providers or `:refresh_oauth` for OAuth-backed providers only. Use `:import_catalog` to import a models.dev directory entry as a configured provider (201): the wire protocol and endpoint come from the catalog resolution (`base_url` overrides it; required when the entry resolves to needs-base-url), all catalogued models are written as aliases, and importing an id that already exists is a refresh — the provider entry and its aliases are rewritten from the catalog (OAuth-managed providers are rejected instead). `id` overrides the catalog id as the local provider id. Use `:import_registry` to import a models.dev-shaped private registry (api.json `url` + optional Bearer `api_key`, 201): every listed provider is written with a `source` blob so scheduled refreshes rediscover it, and re-importing the same URL removes providers that disappeared upstream (the URL is the stable registry identity). For both imports the global default_provider/default_model pointers are never modified — except that a default_model is seeded from the first imported model when none is configured at all (fresh setup).',
      tags: ['providers'],
      operationId: 'providerCollectionAction',
    },
    async (req, reply) => {
      const raw = req.params.action;
      const action = raw.startsWith(':') ? raw.slice(1) : raw;
      if (action === 'refresh_oauth') {
        const result = await (await loadOAuth(core)).refreshOAuthProviderModels();
        reply.send(okEnvelope(result, req.id));
        return;
      }
      if (action === 'refresh') {
        const result = await (await loadDiscovery(core)).refreshProviderModels({ scope: 'all' });
        reply.send(okEnvelope(result, req.id));
        return;
      }
      if (action === 'import_catalog') {
        await enqueueProviderWrite(() => handleImportCatalog(req, reply, core));
        return;
      }
      if (action === 'import_registry') {
        await enqueueProviderWrite(() => handleImportRegistry(req, reply, core));
        return;
      }
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${raw}`, req.id));
    },
  );
  app.post(
    refreshProvidersRoute.path,
    refreshProvidersRoute.options,
    refreshProvidersRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const refreshProviderRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers/{tail}',
      params: providerActionTailParamSchema,
      success: { data: refreshProviderModelsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description: 'Refresh model metadata for a single provider',
      tags: ['providers'],
      operationId: 'refreshProvider',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['refresh'] as const,
          resourceLabel: 'provider',
        });
        if (parsed.kind !== 'action') {
          const message =
            parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = await (await loadDiscovery(core)).refreshProviderModels({
          providerId: parsed.id,
        });
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        if (sendMappedError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.post(
    refreshProviderRoute.path,
    refreshProviderRoute.options,
    refreshProviderRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const getProviderRoute = defineRoute(
    {
      method: 'GET',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      success: { data: getProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description:
        'Get a configured provider by ID. Unlike the list route, the response reveals the stored `api_key` when one is set, so local clients can prefill an edit form.',
      tags: ['providers'],
    },
    async (req, reply) => {
      try {
        const { provider_id } = req.params;
        const provider = await (await loadCatalog(core)).getProvider(provider_id);
        const config = await loadConfig(core);
        const stored = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue?.[provider_id];
        const apiKey = stored?.apiKey;
        reply.send(
          okEnvelope(
            apiKey !== undefined && apiKey !== '' ? { ...provider, api_key: apiKey } : provider,
            req.id,
          ),
        );
      } catch (err) {
        if (sendMappedError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.get(
    getProviderRoute.path,
    getProviderRoute.options,
    getProviderRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const deleteProviderRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_OAUTH_MANAGED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      rawResponse: {
        204: { description: 'Provider deleted.' },
      },
      description:
        'Delete a provider and all of its model aliases (204, no body). The global default_provider/default_model pointers are left untouched — they are the user\'s settings, not this endpoint\'s to garbage-collect. OAuth-managed providers are rejected: log out via /oauth/logout instead.',
      tags: ['providers'],
      operationId: 'deleteProvider',
    },
    async (req, reply) => {
      await enqueueProviderWrite(async () => {
        const config = await loadConfig(core);
        const { provider_id } = req.params;
        const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
        const target = providers[provider_id];
        if (target === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_NOT_FOUND,
              `provider ${provider_id} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if (target.oauth !== undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_OAUTH_MANAGED,
              `provider ${provider_id} is managed by OAuth login; use POST /oauth/logout instead`,
              req.id,
            ),
          );
          return;
        }

        const models = config.inspect<ModelsSection>(MODELS_SECTION).userValue ?? {};
        const restProviders = { ...providers };
        delete restProviders[provider_id];
        await config.replace(PROVIDERS_SECTION, restProviders);
        const restModels = Object.fromEntries(
          Object.entries(models).filter(([, record]) => record.provider !== provider_id),
        );
        if (Object.keys(restModels).length !== Object.keys(models).length) {
          await config.replace(MODELS_SECTION, restModels);
        }
        const secondaryModel = config.inspect<SecondaryModelConfig>(
          SECONDARY_MODEL_SECTION,
        ).userValue;
        const cascadedPool = cascadeSubagentModelPool(secondaryModel, restModels);
        if (cascadedPool !== undefined) {
          await config.replace(SECONDARY_MODEL_SECTION, cascadedPool);
        }
        (reply as unknown as StatusReply).code(204).send();
      });
    },
  );
  app.delete(
    deleteProviderRoute.path,
    deleteProviderRoute.options,
    deleteProviderRoute.handler as Parameters<ModelCatalogRouteHost['delete']>[2],
  );

  const listCatalogProvidersRoute = defineRoute(
    {
      method: 'GET',
      path: '/catalog/providers',
      success: { data: listCatalogProvidersResponseSchema },
      errors: { [ErrorCode.CATALOG_UNAVAILABLE]: {} },
      description:
        'Browse the models.dev directory (server-proxied, 10-minute in-memory cache, built-in snapshot fallback). Entries the server cannot import carry `rejected: true` with a machine-readable `reject_reason`; entries with `needs_base_url: true` require a base URL at import time. Items keep the upstream directory order.',
      tags: ['providers'],
      operationId: 'listCatalogProviders',
    },
    async (req, reply) => {
      try {
        const items = await core.accessor.get(IModelsDevImportService).listModelsDevProviders();
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        if (sendModelsDevImportError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.get(
    listCatalogProvidersRoute.path,
    listCatalogProvidersRoute.options,
    listCatalogProvidersRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const getCatalogProviderRoute = defineRoute(
    {
      method: 'GET',
      path: '/catalog/providers/{catalog_id}',
      params: catalogIdParamSchema,
      success: { data: getCatalogProviderResponseSchema },
      errors: {
        [ErrorCode.CATALOG_ENTRY_NOT_FOUND]: {},
        [ErrorCode.CATALOG_UNAVAILABLE]: {},
      },
      description: 'Get one models.dev directory entry by catalog id.',
      tags: ['providers'],
      operationId: 'getCatalogProvider',
    },
    async (req, reply) => {
      try {
        const { catalog_id } = req.params;
        const item = await core.accessor.get(IModelsDevImportService).getModelsDevProvider(catalog_id);
        reply.send(okEnvelope(item, req.id));
      } catch (err) {
        if (sendModelsDevImportError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.get(
    getCatalogProviderRoute.path,
    getCatalogProviderRoute.options,
    getCatalogProviderRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): boolean {
  if (!isError2(err)) return false;
  if (err.code === 'provider.not_found') {
    reply.send(errEnvelope(ErrorCode.PROVIDER_NOT_FOUND, err.message, requestId, err.stack));
    return true;
  }
  if (err.code === 'model.not_found') {
    reply.send(errEnvelope(ErrorCode.MODEL_NOT_FOUND, err.message, requestId, err.stack));
    return true;
  }
  return false;
}

const MODELS_DEV_IMPORT_ERROR_CODES: Record<string, number> = {
  [ModelsDevImportErrors.codes.CATALOG_UNAVAILABLE]: ErrorCode.CATALOG_UNAVAILABLE,
  [ModelsDevImportErrors.codes.CATALOG_ENTRY_NOT_FOUND]: ErrorCode.CATALOG_ENTRY_NOT_FOUND,
  [ModelsDevImportErrors.codes.CATALOG_IMPORT_INVALID]: ErrorCode.CATALOG_IMPORT_INVALID,
  [ModelsDevImportErrors.codes.REGISTRY_IMPORT_INVALID]: ErrorCode.REGISTRY_IMPORT_INVALID,
  [ModelsDevImportErrors.codes.PROVIDER_OAUTH_MANAGED]: ErrorCode.PROVIDER_OAUTH_MANAGED,
};

function sendModelsDevImportError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): boolean {
  if (!isError2(err)) return false;
  const numeric = MODELS_DEV_IMPORT_ERROR_CODES[err.code];
  if (numeric === undefined) return false;
  reply.send(errEnvelope(numeric, err.message, requestId, err.stack));
  return true;
}

async function handleImportCatalog(
  req: { id: string; body: ProviderCollectionActionBody | undefined },
  reply: { send(payload: unknown): unknown },
  core: Scope,
): Promise<void> {
  try {
    const body = req.body;
    if (body?.catalog_id === undefined) {
      reply.send(
        errEnvelope(
          ErrorCode.VALIDATION_FAILED,
          'catalog_id is required for :import_catalog',
          req.id,
        ),
      );
      return;
    }

    const result = await core.accessor.get(IModelsDevImportService).importModelsDevProvider({
      catalogId: body.catalog_id,
      id: body.id,
      apiKey: body.api_key,
      baseUrl: body.base_url,
    });
    (reply as unknown as StatusReply)
      .code(201)
      .send(
        okEnvelope(
          { provider: result.provider, models_imported: result.modelsImported },
          req.id,
        ),
      );
  } catch (err) {
    if (sendModelsDevImportError(reply, req.id, err)) return;
    throw err;
  }
}

async function handleImportRegistry(
  req: { id: string; body: ProviderCollectionActionBody | undefined },
  reply: { send(payload: unknown): unknown },
  core: Scope,
): Promise<void> {
  try {
    const body = req.body;
    if (body?.url === undefined) {
      reply.send(
        errEnvelope(ErrorCode.VALIDATION_FAILED, 'url is required for :import_registry', req.id),
      );
      return;
    }
    const result = await core.accessor.get(IModelsDevImportService).importCustomRegistry({
      url: body.url,
      apiKey: body.api_key,
    });
    (reply as unknown as StatusReply)
      .code(201)
      .send(
        okEnvelope(
          { providers: result.providers, models_imported: result.modelsImported },
          req.id,
        ),
      );
  } catch (err) {
    if (sendModelsDevImportError(reply, req.id, err)) return;
    throw err;
  }
}

