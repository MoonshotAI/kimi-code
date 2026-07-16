import {
  ErrorCode,
  guiStoreGetItemQuerySchema,
  guiStoreGetItemResponseSchema,
  guiStoreLengthResponseSchema,
  guiStoreRemoveItemBodySchema,
  guiStoreSetItemBodySchema,
} from '@moonshot-ai/protocol';
import { z } from 'zod';
import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { IGuiStoreService } from '#/services/guiStore/guiStore';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

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

export function registerGuiStoreRoutes(
  app: GuiStoreRouteHost,
  ix: IInstantiationService,
): void {
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
      const value = await ix.invokeFunction((a) =>
        a.get(IGuiStoreService).getItem(req.query.key),
      );
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
      await ix.invokeFunction((a) =>
        a.get(IGuiStoreService).setItem(req.body.key, req.body.value),
      );
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
      await ix.invokeFunction((a) =>
        a.get(IGuiStoreService).removeItem(req.body.key),
      );
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
    async (req, reply) => {
      await ix.invokeFunction((a) => a.get(IGuiStoreService).clear());
      reply.send(okEnvelope(null, req.id));
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
      const length = await ix.invokeFunction((a) => a.get(IGuiStoreService).length());
      reply.send(okEnvelope({ length }, req.id));
    },
  );
  app.get(
    lengthRoute.path,
    lengthRoute.options,
    lengthRoute.handler as Parameters<GuiStoreRouteHost['get']>[2],
  );
}
