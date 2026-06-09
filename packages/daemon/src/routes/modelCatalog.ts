import { z } from 'zod';

import {
  ErrorCode,
  getProviderResponseSchema,
  listModelsResponseSchema,
  listProvidersResponseSchema,
  setDefaultModelResponseSchema,
} from '@moonshot-ai/protocol';
import {
  IModelCatalogService,
  ModelNotFoundError,
  ProviderNotFoundError,
} from '@moonshot-ai/services';
import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

interface ModelCatalogRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
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

export function registerModelCatalogRoutes(
  app: ModelCatalogRouteHost,
  ix: IInstantiationService,
): void {
  const listModelsRoute = defineRoute(
    {
      method: 'GET',
      path: '/models',
      success: { data: listModelsResponseSchema },
      description: 'List configured model aliases',
      tags: ['models'],
    },
    async (req, reply) => {
      const items = await ix.invokeFunction((a) =>
        a.get(IModelCatalogService).listModels(),
      );
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
          const message = parsed.kind === 'invalid'
            ? parsed.reason
            : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = await ix.invokeFunction((a) =>
          a.get(IModelCatalogService).setDefaultModel(parsed.id),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
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
      const items = await ix.invokeFunction((a) =>
        a.get(IModelCatalogService).listProviders(),
      );
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listProvidersRoute.path,
    listProvidersRoute.options,
    listProvidersRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
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
        const provider = await ix.invokeFunction((a) =>
          a.get(IModelCatalogService).getProvider(provider_id),
        );
        reply.send(okEnvelope(provider, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    getProviderRoute.path,
    getProviderRoute.options,
    getProviderRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof ProviderNotFoundError) {
    const error = err as ProviderNotFoundError;
    reply.send(errEnvelope(ErrorCode.PROVIDER_NOT_FOUND, error.message, requestId));
    return;
  }
  if (err instanceof ModelNotFoundError) {
    const error = err as ModelNotFoundError;
    reply.send(errEnvelope(ErrorCode.MODEL_NOT_FOUND, error.message, requestId));
    return;
  }
  throw err;
}
