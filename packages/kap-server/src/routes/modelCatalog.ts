/**
 * `/models` + `/providers` catalog route handlers — server-v2 port.
 *
 * Implements the v1 model/provider catalog wire contract on top of
 * `agent-core-v2`'s `IModelCatalog` (the remote-discovery refresh lives on
 * `IProviderDiscoveryService`; the OAuth-only managed refresh additionally
 * lives on `IOAuthService`):
 *   GET    /models                       — list configured model aliases
 *   GET    /providers                    — list configured providers
 *   GET    /providers/{provider_id}      — get a configured provider by id
 *   POST   /providers                    — create a provider manually
 *   PUT    /providers/{provider_id}      — replace a provider + rebuild its model aliases
 *   DELETE /providers/{provider_id}      — delete a provider + its model aliases
 *   GET    /catalog/providers            — browse the models.dev directory (proxied)
 *   GET    /catalog/providers/{catalog_id} — get one directory entry
 *   POST   /providers:import_catalog     — import a directory entry as a provider
 *   POST   /models/{tail} (:set_default) — set the global default model alias
 *   POST   /providers:refresh            — refresh ALL refreshable providers
 *   POST   /providers:refresh_oauth      — refresh OAuth-backed provider models
 *   POST   /providers/{tail} (:refresh)  — refresh a single provider by id
 *
 * **Wire fidelity**: reuses agent-core-v2's catalog schemas and the local
 * numeric `ErrorCode` envelope verbatim, so the response shape and error codes
 * (`40412` provider-not-found, `40413` model-not-found, `40001` validation) are
 * byte-for-byte compatible with v1's `routes/modelCatalog.ts`. The v2 domain
 * throws coded `Error2`s (`provider.not_found` / `model.not_found`); this
 * edge maps them to the numeric protocol codes by `code` (never `instanceof`).
 *
 * **Write surface**: create/replace/delete write the user config layer through
 * `IConfigService`. Replace and delete use whole-section `replace` (deep-merge
 * `set` can never drop a key). One subtlety shapes all the write code below:
 * the providers/models TOML transforms rebuild each section's entries but
 * overlay each entry's fields onto the old on-disk raw — so an entry id
 * absent from the replacement truly disappears, while a FIELD absent from a
 * kept entry would silently survive on disk (and resurrect on the next boot).
 * Field-level clears therefore always assign an explicit `undefined` (the
 * transform's `setDefined` drops those), and the import refreshes swap
 * aliases in two passes (drop, then re-add onto clean slots). The kosong
 * persistence bridge then pushes the change into the registries, which is
 * also what invalidates the catalog cache. Multi-step sequences are
 * serialized through `enqueueProviderWrite`.
 */

import {
  IConfigService,
  IKosongConfigService,
  IModelCatalog,
  IOAuthService,
  IProviderDiscoveryService,
  isError2,
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
import { z } from 'zod';

import {
  applyCustomRegistryProvider,
  fetchCustomRegistry,
  removeCustomRegistryProvider,
  type CustomRegistryProviderEntry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
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
  providerIdSchema,
  replaceProviderRequestSchema,
  replaceProviderResponseSchema,
  type ProviderCollectionActionBody,
} from '../protocol/rest-modelCatalog';
import {
  CatalogUnavailableError,
  catalogEntry,
  catalogModelToRecord,
  getCatalog,
  toCatalogProviderItem,
  upstreamFetch,
  UPSTREAM_FETCH_TIMEOUT_MS,
} from '../catalogUpstream';
import { catalogProviderModels, resolveCatalogImport } from '@moonshot-ai/kosong';
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

/** Reply shape used where a route answers a non-200 status (201/204). */
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

/**
 * Resolve the catalog service after the config layer is ready. Config loads
 * asynchronously during bootstrap; mirroring `routes/config.ts`, route handlers
 * await `IConfigService.ready` so an immediate request never observes an empty
 * (not-yet-loaded) catalog.
 */
async function loadCatalog(core: Scope): Promise<IModelCatalog> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IModelCatalog);
}

/**
 * Resolve the config service for the write routes once the kosong persistence
 * bridge is also ready. The bridge subscribes to section changes after the
 * initial hydration; awaiting it guarantees a write below reaches the kosong
 * registries (and the catalog-cache invalidation riding them) before the
 * handler reads back or returns.
 */
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

/**
 * Serializes the provider write routes' multi-step sequences (inspect → build
 * → replace × N). The config service only serializes individual writes, so
 * two interleaved edits could otherwise lose each other's section rebuilds
 * (or land a half-migrated rename). The refresh routes are excluded — the
 * discovery service chains its own runs.
 */
let providerWriteChain: Promise<unknown> = Promise.resolve();

function enqueueProviderWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = providerWriteChain.then(task, task);
  providerWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Seed the global default model when — and only when — none is configured.
 * Provider writes otherwise never move the default pointers, but a fresh
 * setup has no pointer at all: the first provider added must leave the
 * daemon usable (GET /auth's readiness requires a default model). An
 * existing pointer is never rewritten here, not even a dangling one — it is
 * the user's setting, not this route's to second-guess.
 */
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
          // The provider-level default references the model alias id
          // (`<id>/<model>`), the form runtime resolution reads back.
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

        // A fresh setup has no default model at all: seed it with the
        // provider's own default (or its first model) so the first provider
        // added leaves the daemon usable. Existing pointers are never moved.
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

        // Whole-section replace (not deep-merge `set`, which could never drop
        // the old api_key/base_url/default_model keys when they leave the form).
        // The provider record itself merges like the model records below do:
        // fields the form does not know (custom_headers / env / the registry
        // `source` blob that scheduled refreshes rediscover by) ride along on
        // `target`; the fields the form owns are authoritative — absent from
        // the body means cleared. api_key tri-state: field absent keeps the
        // stored key, "" clears it — persisted as `api_key = ""`, the same
        // cleared form authService writes (runtime credential resolution
        // treats "" as no key).
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
        // Explicit `undefined` assignments (NOT `delete`): the TOML transform is
        // a raw overlay that only drops a key when the new value carries the key
        // with an undefined value (`setDefined`); a missing key would keep the
        // old on-disk value alive and resurrect it on the next boot.
        provider.apiKey = req.body.api_key ?? target.apiKey;
        provider.baseUrl = req.body.base_url;
        provider.defaultModel =
          req.body.default_model !== undefined
            ? // The provider-level default references the model alias id
              // (`<id>/<model>`), the same form create persists.
              `${newId}/${req.body.default_model}`
            : undefined;
        // A rename is a key swap on the same section; every other entry (and its
        // TOML position) is untouched.
        const nextProviders = Object.fromEntries(
          Object.entries(providers).map(([key, value]) => [
            key === provider_id ? newId : key,
            value,
          ]),
        );
        nextProviders[newId] = provider;

        // Foreign-prefix collision guard: alias keys are global, and a kept
        // alias owned by ANOTHER provider may already sit on a `<newId>/<model>`
        // key the rebuild would write — refuse instead of silently retargeting
        // it. Checked BEFORE any write so a collision never lands half the edit.
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

        // Rebuild the provider's aliases from the submitted list: keep every
        // alias owned by other providers, drop the old set, append the new one.
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
          // Merge onto the existing record so fields the form does not know
          // (betaApi / reasoningKey / protocol / per-model baseUrl / overrides /
          // defaultEffort / maxInputSize …) survive an edit; only models the
          // user removed lose their record. Fields the form does know are
          // authoritative — absent from the body means cleared, and the clear
          // must be an explicit `undefined` assignment (never `delete`): the
          // TOML transform is a raw overlay that only drops a key when the new
          // record carries it with an undefined value.
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

        // Migrate the global pointers on rename — and ONLY on rename: provider
        // writes never clear default_provider/default_model, not even when the
        // rebuild drops the alias they point at (the pointer is the user's
        // setting, not this endpoint's to garbage-collect). default_model is
        // repointed via the old record's bare model name, not the alias key —
        // old aliases may carry a foreign prefix.
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
      // One route hosts every collection-level action because find-my-way
      // cannot register a static `/providers:import_catalog` next to the
      // in-segment `:action` parameter. The body applies to `import_catalog`
      // only; the refresh actions are invoked without one.
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
        const catalog = await getCatalog();
        const items = Object.entries(catalog).map(([id, entry]) => toCatalogProviderItem(id, entry));
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        if (sendCatalogError(reply, req.id, err)) return;
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
        const catalog = await getCatalog();
        const { catalog_id } = req.params;
        const entry = catalogEntry(catalog, catalog_id);
        if (entry === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.CATALOG_ENTRY_NOT_FOUND,
              `catalog entry ${catalog_id} does not exist`,
              req.id,
            ),
          );
          return;
        }
        reply.send(okEnvelope(toCatalogProviderItem(catalog_id, entry), req.id));
      } catch (err) {
        if (sendCatalogError(reply, req.id, err)) return;
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

/** Map a coded domain error to the numeric protocol envelope. Returns true if handled. */
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

/** Map a catalog-upstream failure to the numeric protocol envelope. Returns true if handled. */
function sendCatalogError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): boolean {
  if (err instanceof CatalogUnavailableError) {
    reply.send(errEnvelope(ErrorCode.CATALOG_UNAVAILABLE, err.message, requestId, err.stack));
    return true;
  }
  return false;
}

/**
 * The `:import_catalog` collection action. Lives behind `/providers:action`
 * because find-my-way cannot register a static `/providers:import_catalog`
 * next to the in-segment `:action` parameter.
 */
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

    const catalog = await getCatalog();
    const { catalog_id } = body;
    const entry = catalogEntry(catalog, catalog_id);
    if (entry === undefined) {
      reply.send(
        errEnvelope(
          ErrorCode.CATALOG_ENTRY_NOT_FOUND,
          `catalog entry ${catalog_id} does not exist`,
          req.id,
        ),
      );
      return;
    }

    const resolution = resolveCatalogImport(entry, body.base_url);
    if (resolution.kind === 'invalid') {
      reply.send(
        errEnvelope(
          ErrorCode.CATALOG_IMPORT_INVALID,
          `catalog entry ${catalog_id} cannot be imported: ${resolution.reason}`,
          req.id,
        ),
      );
      return;
    }
    if (resolution.kind === 'needs-base-url') {
      reply.send(
        errEnvelope(
          ErrorCode.CATALOG_IMPORT_INVALID,
          `catalog entry ${catalog_id} requires a base_url`,
          req.id,
        ),
      );
      return;
    }

    const models = catalogProviderModels(entry);
    if (models.length === 0) {
      reply.send(
        errEnvelope(
          ErrorCode.CATALOG_IMPORT_INVALID,
          `catalog entry ${catalog_id} has no importable models`,
          req.id,
        ),
      );
      return;
    }

    const config = await loadConfig(core);
    const targetId = body.id ?? catalog_id;
    if (!providerIdSchema.safeParse(targetId).success) {
      reply.send(
        errEnvelope(
          ErrorCode.CATALOG_IMPORT_INVALID,
          `catalog entry id ${targetId} cannot be used as a provider id`,
          req.id,
        ),
      );
      return;
    }
    const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
    const existing = providers[targetId];
    if (existing?.oauth !== undefined) {
      reply.send(
        errEnvelope(
          ErrorCode.PROVIDER_OAUTH_MANAGED,
          `provider ${targetId} is managed by OAuth login; use POST /oauth/logout instead`,
          req.id,
        ),
      );
      return;
    }

    // api_key is tri-state like PUT: absent keeps the stored key on a
    // re-import (a refresh must not silently drop the credential), "" clears
    // it, anything else replaces it. base_url follows the catalog resolution —
    // explicit `undefined` when the wire needs none, so a stale on-disk value
    // is really cleared (the TOML transform is a raw overlay that only drops
    // keys assigned an explicit undefined). The global default pointers are
    // deliberately left alone (aside from the fresh-setup seeding below).
    const provider: ProviderConfig = { type: resolution.wire };
    provider.baseUrl = resolution.baseUrl;
    provider.apiKey = body.api_key ?? existing?.apiKey;
    await config.replace(PROVIDERS_SECTION, { ...providers, [targetId]: provider });

    // Two-pass alias swap: pass 1 drops the provider's aliases for real
    // (entry-level deletes ARE honored by the TOML overlay), pass 2 writes the
    // fresh records onto clean slots — a kept alias id would otherwise keep
    // stale on-disk fields the upstream no longer lists.
    const records = config.inspect<ModelsSection>(MODELS_SECTION).userValue ?? {};
    const withoutTarget = Object.fromEntries(
      Object.entries(records).filter(([, record]) => record.provider !== targetId),
    );
    await config.replace(MODELS_SECTION, withoutTarget);
    const nextModels = { ...withoutTarget };
    for (const model of models) {
      nextModels[`${targetId}/${model.id}`] = catalogModelToRecord(targetId, model);
    }
    await config.replace(MODELS_SECTION, nextModels);

    // Same fresh-setup seeding as POST /providers: an existing global
    // default is never moved, but a setup with none becomes usable.
    const firstCatalogModel = models[0];
    if (firstCatalogModel !== undefined) {
      await seedDefaultModelWhenUnset(config, `${targetId}/${firstCatalogModel.id}`);
    }

    const imported = await core.accessor.get(IModelCatalog).getProvider(targetId);
    (reply as unknown as StatusReply)
      .code(201)
      .send(okEnvelope({ provider: imported, models_imported: models.length }, req.id));
  } catch (err) {
    if (sendCatalogError(reply, req.id, err)) return;
    throw err;
  }
}

/**
 * The `:import_registry` collection action: fetch a models.dev-shaped private
 * registry (api.json) and apply every entry. Reuses the core's
 * `fetchCustomRegistry` (fetch + validation) and its
 * `removeCustomRegistryProvider` / `applyCustomRegistryProvider` primitives —
 * the exact remove-then-apply sequence of `applyCustomRegistryEntries`, split
 * into TWO persisted passes so deletions really reach the disk (the TOML
 * transform is a raw overlay that only honors entry-level deletes; applying
 * in the same pass would let stale fields of kept ids survive on disk). The
 * in-memory shapes deliberately omit the default pointers so the core's
 * removal logic can never clamp them: provider writes never move
 * default_provider/default_model (aside from the fresh-setup default_model
 * seeding at the end). An omitted `api_key` inherits the key from
 * the previous import of the same URL (the `source` blob), mirroring PUT's
 * keep-on-absent semantics; "" clears it.
 */
async function handleImportRegistry(
  req: { id: string; body: ProviderCollectionActionBody | undefined },
  reply: { send(payload: unknown): unknown },
  core: Scope,
): Promise<void> {
  const body = req.body;
  if (body?.url === undefined) {
    reply.send(
      errEnvelope(ErrorCode.VALIDATION_FAILED, 'url is required for :import_registry', req.id),
    );
    return;
  }
  const url = body.url;

  const config = await loadConfig(core);
  const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
  const source: CustomRegistrySource = {
    kind: 'apiJson',
    url,
    apiKey: body.api_key ?? registryKeyFromExisting(providers, url) ?? '',
  };

  let entries: Record<string, CustomRegistryProviderEntry>;
  try {
    entries = await fetchCustomRegistry(source, {
      fetchImpl: upstreamFetch(),
      userAgent: 'kimi-code-kap-server',
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    reply.send(
      errEnvelope(
        ErrorCode.REGISTRY_IMPORT_INVALID,
        // Truncate the upstream's error text: a hostile registry could echo
        // the Bearer token it received back inside its error payload.
        `custom registry at ${url} cannot be imported: ${truncateUpstreamMessage(err)}`,
        req.id,
      ),
    );
    return;
  }
  if (Object.keys(entries).length === 0) {
    reply.send(
      errEnvelope(
        ErrorCode.REGISTRY_IMPORT_INVALID,
        `custom registry at ${url} has no importable providers`,
        req.id,
      ),
    );
    return;
  }

  // A registry entry must never rewrite (or delete) an OAuth-managed provider.
  for (const entry of Object.values(entries)) {
    if (providers[entry.id]?.oauth !== undefined) {
      reply.send(
        errEnvelope(
          ErrorCode.PROVIDER_OAUTH_MANAGED,
          `provider ${entry.id} is managed by OAuth login; use POST /oauth/logout instead`,
          req.id,
        ),
      );
      return;
    }
  }

  // Pass 1 (delete): same-URL providers that vanished upstream, plus every
  // listed provider's current records. OAuth-managed entries are defensive-
  // skipped even on the removal path.
  const removed = {
    providers: { ...providers },
    models: {
      ...config.inspect<ModelsSection>(MODELS_SECTION).userValue,
    },
  } as ManagedKimiConfigShape;
  const surviving = new Set(Object.values(entries).map((entry) => entry.id));
  for (const [providerId, provider] of Object.entries(removed.providers)) {
    if (surviving.has(providerId)) continue;
    if (!isRecord(provider)) continue;
    if (provider['oauth'] !== undefined) continue;
    const existingSource = provider['source'];
    if (
      isRecord(existingSource) &&
      existingSource['kind'] === 'apiJson' &&
      existingSource['url'] === url
    ) {
      removeCustomRegistryProvider(removed, providerId);
    }
  }
  for (const entry of Object.values(entries)) {
    if (entry.id in removed.providers) {
      removeCustomRegistryProvider(removed, entry.id);
    }
  }
  await config.replace(PROVIDERS_SECTION, removed.providers as ProvidersSection);
  await config.replace(MODELS_SECTION, (removed.models ?? {}) as ModelsSection);

  // Pass 2 (apply): fresh provider + alias records onto the cleaned slots.
  const applied = {
    providers: removed.providers,
    models: removed.models,
  } as ManagedKimiConfigShape;
  for (const entry of Object.values(entries)) {
    applyCustomRegistryProvider(applied, entry, source);
  }
  await config.replace(PROVIDERS_SECTION, applied.providers as ProvidersSection);
  await config.replace(MODELS_SECTION, (applied.models ?? {}) as ModelsSection);

  // Same fresh-setup seeding as POST /providers / :import_catalog: never
  // moves an existing global default, seeds one from the first imported
  // model when the setup has none.
  const firstEntry = Object.values(entries)[0];
  const firstModelKey = firstEntry === undefined ? undefined : Object.keys(firstEntry.models)[0];
  if (firstEntry !== undefined && firstModelKey !== undefined) {
    await seedDefaultModelWhenUnset(config, `${firstEntry.id}/${firstModelKey}`);
  }

  const imported = [];
  for (const entry of Object.values(entries)) {
    imported.push(await core.accessor.get(IModelCatalog).getProvider(entry.id));
  }
  const modelsImported = Object.values(entries).reduce(
    (total, entry) => total + Object.keys(entry.models).length,
    0,
  );
  (reply as unknown as StatusReply)
    .code(201)
    .send(okEnvelope({ providers: imported, models_imported: modelsImported }, req.id));
}

/** The api_key stored by the previous import of the same registry URL, if any. */
function registryKeyFromExisting(
  providers: ProvidersSection,
  url: string,
): string | undefined {
  for (const provider of Object.values(providers)) {
    if (!isRecord(provider)) continue;
    const source = provider['source'];
    if (isRecord(source) && source['kind'] === 'apiJson' && source['url'] === url) {
      const key = source['apiKey'];
      if (typeof key === 'string' && key.length > 0) return key;
    }
  }
  return undefined;
}

/** Local mirror of the core's `isRecord` (not exported by the oauth package). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cap an upstream error text before it lands in banners/logs. */
function truncateUpstreamMessage(err: unknown, limit = 300): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

