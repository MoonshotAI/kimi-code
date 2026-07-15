/**
 * `/api/v1/gui/store/*` routes — server-backed localStorage mirror.
 */

import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { IGuiStoreService } from '../services/guiStore/guiStore';
import { ErrorCode } from '../protocol/error-codes';
import {
  guiStoreGetItemQuerySchema,
  guiStoreGetItemResponseSchema,
  guiStoreLengthResponseSchema,
  guiStoreRemoveItemBodySchema,
  guiStoreSetItemBodySchema,
} from '../protocol/rest-guiStore';

interface GuiStoreRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query?: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body?: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerGuiStoreRoutes(app: GuiStoreRouteHost, store: IGuiStoreService): void {
  const getItemRoute = defineRoute(
    {
      method: 'GET',
      path: '/gui/store/getItem',
      querystring: guiStoreGetItemQuerySchema,
      success: { data: guiStoreGetItemResponseSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Read a value by key (mirrors localStorage.getItem).',
      tags: ['gui-store'],
    },
    async (req, reply) => {
      const value = await store.getItem((req.query as { key: string }).key);
      reply.send(okEnvelope({ value }, req.id));
    },
  );
  app.get(
    getItemRoute.path,
    getItemRoute.options,
    getItemRoute.handler as Parameters<GuiStoreRouteHost['get']>[2],
  );

  const setItemRoute = defineRoute(
    {
      method: 'POST',
      path: '/gui/store/setItem',
      body: guiStoreSetItemBodySchema,
      success: { data: z.null() },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Write a value by key (mirrors localStorage.setItem).',
      tags: ['gui-store'],
    },
    async (req, reply) => {
      const body = req.body as { key: string; value: string };
      await store.setItem(body.key, body.value);
      reply.send(okEnvelope(null, req.id));
    },
  );
  app.post(
    setItemRoute.path,
    setItemRoute.options,
    setItemRoute.handler as Parameters<GuiStoreRouteHost['post']>[2],
  );

  const removeItemRoute = defineRoute(
    {
      method: 'POST',
      path: '/gui/store/removeItem',
      body: guiStoreRemoveItemBodySchema,
      success: { data: z.null() },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Delete a value by key (mirrors localStorage.removeItem).',
      tags: ['gui-store'],
    },
    async (req, reply) => {
      await store.removeItem((req.body as { key: string }).key);
      reply.send(okEnvelope(null, req.id));
    },
  );
  app.post(
    removeItemRoute.path,
    removeItemRoute.options,
    removeItemRoute.handler as Parameters<GuiStoreRouteHost['post']>[2],
  );

  const clearRoute = defineRoute(
    {
      method: 'POST',
      path: '/gui/store/clear',
      success: { data: z.null() },
      description: 'Delete all values (mirrors localStorage.clear).',
      tags: ['gui-store'],
    },
    async (_req, reply) => {
      await store.clear();
      reply.send(okEnvelope(null, _req.id));
    },
  );
  app.post(
    clearRoute.path,
    clearRoute.options,
    clearRoute.handler as Parameters<GuiStoreRouteHost['post']>[2],
  );

  const lengthRoute = defineRoute(
    {
      method: 'GET',
      path: '/gui/store/length',
      success: { data: guiStoreLengthResponseSchema },
      description: 'Number of stored keys (mirrors localStorage.length).',
      tags: ['gui-store'],
    },
    async (req, reply) => {
      const length = await store.length();
      reply.send(okEnvelope({ length }, req.id));
    },
  );
  app.get(
    lengthRoute.path,
    lengthRoute.options,
    lengthRoute.handler as Parameters<GuiStoreRouteHost['get']>[2],
  );
}
