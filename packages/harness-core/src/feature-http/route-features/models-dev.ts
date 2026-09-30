import type { Request, Response } from 'express';

import { ProviderCatalogRef, useInject } from '@moonshot-ai/agent-core';

import { ModelsDevError, ModelsDevRef, type ModelsDevFace } from '#/features/models-dev/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';

const COLLECTION_ACTIONS = ['refresh', 'import_catalog', 'import_registry'] as const;

type CollectionAction = (typeof COLLECTION_ACTIONS)[number];

export function useModelsDevRoutes(prefix: string): void {
  useHttpRoute({
    id: 'catalog.providers.list',
    method: 'GET',
    path: `${prefix}/catalog/providers`,
    handler: async (request, response) => {
      const facade = modelsDevFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, { items: await facade.listProviders() });
      } catch (error) {
        if (sendModelsDevErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'catalog.providers.get',
    method: 'GET',
    path: `${prefix}/catalog/providers/:catalog_id`,
    handler: async (request, response) => {
      const catalogId = param(request, 'catalog_id');
      if (catalogId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'catalog_id is required', 400);
        return;
      }
      const facade = modelsDevFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, await facade.getProvider(catalogId));
      } catch (error) {
        if (sendModelsDevErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'catalog.providers.import',
    method: 'POST',
    path: `${prefix}/providers:action`,
    handler: async (request, response) => {
      const raw = param(request, 'action');
      const action = raw?.startsWith(':') ? (raw.slice(1) as CollectionAction) : undefined;
      if (action === undefined || !COLLECTION_ACTIONS.includes(action)) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          `unsupported action: ${raw ?? ''}`,
          400,
        );
        return;
      }
      if (action === 'refresh') {
        const store = useInject(ProviderCatalogRef).value;
        if (store === undefined) {
          sendErr(
            request,
            response,
            ErrorCode.PROVIDER_CATALOG_UNAVAILABLE,
            'model catalog is unavailable (provider-catalog feature is not installed)',
            409,
          );
          return;
        }
        const providers = store.providers();
        for (const providerId of providers) {
          store.refresh(providerId);
        }
        sendOk(request, response, { changed: [], unchanged: providers, failed: [] });
        return;
      }
      const facade = modelsDevFacade(request, response);
      if (facade === undefined) return;
      const body = readImportBody(request.body);
      if (action === 'import_catalog') {
        if (body?.catalogId === undefined) {
          sendErr(
            request,
            response,
            ErrorCode.VALIDATION_FAILED,
            'catalog_id is required for :import_catalog',
            400,
          );
          return;
        }
        try {
          sendOk(request, response, await facade.importProvider({
            catalogId: body.catalogId,
            id: body.id,
            apiKey: body.apiKey,
            baseUrl: body.baseUrl,
          }), 201);
        } catch (error) {
          if (sendModelsDevErr(request, response, error)) return;
          throw error;
        }
        return;
      }
      if (body?.url === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'url is required for :import_registry',
          400,
        );
        return;
      }
      try {
        sendOk(request, response, await facade.importRegistry({ url: body.url, apiKey: body.apiKey }), 201);
      } catch (error) {
        if (sendModelsDevErr(request, response, error)) return;
        throw error;
      }
    },
  });
}

interface ImportBody {
  readonly catalogId?: string;
  readonly id?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly url?: string;
}

function readImportBody(body: unknown): ImportBody | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const stringField = (name: string): string | undefined => {
    const value = record[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  return {
    catalogId: stringField('catalog_id'),
    id: stringField('id'),
    apiKey: stringField('api_key'),
    baseUrl: stringField('base_url'),
    url: stringField('url'),
  };
}

function modelsDevFacade(request: Request, response: Response): ModelsDevFace | undefined {
  const facade = useInject(ModelsDevRef).value;
  if (facade === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.MODELS_DEV_UNAVAILABLE,
      'models.dev catalog is unavailable (models-dev feature is not installed)',
      409,
    );
  }
  return facade;
}

function sendModelsDevErr(request: Request, response: Response, error: unknown): boolean {
  if (!(error instanceof ModelsDevError)) return false;
  if (error.code === 'modelsDev.catalog_entry_not_found') {
    sendErr(request, response, ErrorCode.CATALOG_ENTRY_NOT_FOUND, error.message, 404);
    return true;
  }
  if (error.code === 'provider.oauth_managed') {
    sendErr(request, response, ErrorCode.PROVIDER_OAUTH_MANAGED, error.message, 409);
    return true;
  }
  if (error.code === 'modelsDev.import_invalid') {
    sendErr(request, response, ErrorCode.CATALOG_IMPORT_INVALID, error.message, 400);
    return true;
  }
  if (error.code === 'modelsDev.registry_import_invalid') {
    sendErr(request, response, ErrorCode.REGISTRY_IMPORT_INVALID, error.message, 400);
    return true;
  }
  if (error.code === 'config.unavailable') {
    sendErr(request, response, ErrorCode.MODELS_DEV_UNAVAILABLE, error.message, 409);
    return true;
  }
  if (error.code === 'modelsDev.catalog_unavailable') {
    sendErr(request, response, ErrorCode.CATALOG_UNAVAILABLE, error.message, 502);
    return true;
  }
  return false;
}
