/**
 * `/models` + `/providers` catalog route handlers — server-v2 port.
 *
 * Implements the v1 model/provider catalog wire contract on top of
 * `agent-core-v2`'s `IModelCatalog` (the remote-discovery refresh lives on
 * `IProviderDiscoveryService`; the OAuth-only managed refresh additionally
 * lives on `IOAuthService`):
 *   GET  /models                       — list configured model aliases
 *   GET  /providers                    — list configured providers
 *   GET  /providers/{provider_id}      — get a configured provider by id
 *   POST /models/{tail} (:set_default) — set the global default model alias
 *   POST /providers:refresh            — refresh ALL refreshable providers
 *   POST /providers:refresh_oauth      — refresh OAuth-backed provider models
 *   POST /providers/{tail} (:refresh)  — refresh a single provider by id
 *
 * **Wire fidelity**: reuses agent-core-v2's catalog schemas and the local
 * numeric `ErrorCode` envelope verbatim, so the response shape and error codes
 * (`40412` provider-not-found, `40413` model-not-found, `40001` validation) are
 * byte-for-byte compatible with v1's `routes/modelCatalog.ts`. The v2 domain
 * throws coded `Error2`s (`provider.not_found` / `model.not_found`); this
 * edge maps them to the numeric protocol codes by `code` (never `instanceof`).
 */

import {
  IConfigService,
  IModelCatalog,
  IOAuthService,
  IProviderDiscoveryService,
  isError2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { setDefaultModelResponseSchema } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import { refreshProviderModelsResponseSchema } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  getProviderResponseSchema,
  listModelsResponseSchema,
  listProvidersResponseSchema,
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

async function loadDiscovery(core: Scope): Promise<IProviderDiscoveryService> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IProviderDiscoveryService);
}

async function loadOAuth(core: Scope): Promise<IOAuthService> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IOAuthService);
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

  const refreshProvidersRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers:action',
      params: providerCollectionActionParamSchema,
      success: { data: refreshProviderModelsResponseSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description:
        'Refresh provider model metadata. Use `:refresh` for all providers or `:refresh_oauth` for OAuth-backed providers only.',
      tags: ['providers'],
      operationId: 'refreshProviderModels',
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
      description: 'Get a configured provider by ID',
      tags: ['providers'],
    },
    async (req, reply) => {
      try {
        const { provider_id } = req.params;
        const provider = await (await loadCatalog(core)).getProvider(provider_id);
        reply.send(okEnvelope(provider, req.id));
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
