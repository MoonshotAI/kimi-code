import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  guiStoreGetQuerySchema,
  guiStorePatchBodySchema,
  guiStorePatchResponseSchema,
  guiStoreSnapshotSchema,
} from '../protocol/rest-guiStore';
import {
  GuiStoreCorruptError,
  GuiStorePersistenceError,
  IGuiStoreService,
} from '../services/guiStore/guiStore';

const PATCH_BODY_LIMIT_BYTES = 8 * 1_048_576;

interface GuiStoreRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query?: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  patch(
    path: string,
    options: { schema?: Record<string, unknown>; bodyLimit?: number },
    handler: (
      req: { id: string; body?: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerGuiStoreRoutes(app: GuiStoreRouteHost, store: IGuiStoreService): void {
  const getSnapshotRoute = defineRoute(
    {
      method: 'GET',
      path: '/gui/store',
      querystring: guiStoreGetQuerySchema,
      success: { data: guiStoreSnapshotSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PERSISTENCE_FAILURE]: {},
      },
      description: 'Read a versioned snapshot of persisted GUI store entries.',
      tags: ['gui-store'],
    },
    async (req, reply) => {
      const query = (req.query ?? {}) as { prefix?: string; keys?: string | string[] };
      const keys =
        query.keys === undefined
          ? undefined
          : Array.isArray(query.keys)
            ? query.keys
            : [query.keys];
      try {
        const snapshot = await store.getSnapshot({ prefix: query.prefix, keys });
        reply.send(okEnvelope(snapshot, req.id));
      } catch (error) {
        if (error instanceof GuiStoreCorruptError) {
          reply.send(
            errEnvelope(ErrorCode.PERSISTENCE_FAILURE, error.message, req.id, {
              quarantine_path: error.quarantinePath,
            }),
          );
          return;
        }
        if (error instanceof GuiStorePersistenceError) {
          reply.send(errEnvelope(ErrorCode.PERSISTENCE_FAILURE, error.message, req.id));
          return;
        }
        throw error;
      }
    },
  );
  app.get(
    getSnapshotRoute.path,
    getSnapshotRoute.options,
    getSnapshotRoute.handler as Parameters<GuiStoreRouteHost['get']>[2],
  );

  const patchRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/gui/store',
      body: guiStorePatchBodySchema,
      success: { data: guiStorePatchResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PERSISTENCE_FAILURE]: {},
      },
      description:
        'Atomically upsert or delete GUI store entries with optional per-key optimistic concurrency checks.',
      tags: ['gui-store'],
    },
    async (req, reply) => {
      const body = req.body as {
        mutations: Array<{ key: string; value: string | null; if_revision?: number }>;
      };
      try {
        const result = await store.patch(
          body.mutations.map((item) => ({
            key: item.key,
            value: item.value,
            ifRevision: item.if_revision,
          })),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        if (error instanceof GuiStoreCorruptError) {
          reply.send(
            errEnvelope(ErrorCode.PERSISTENCE_FAILURE, error.message, req.id, {
              quarantine_path: error.quarantinePath,
            }),
          );
          return;
        }
        if (error instanceof GuiStorePersistenceError) {
          reply.send(errEnvelope(ErrorCode.PERSISTENCE_FAILURE, error.message, req.id));
          return;
        }
        throw error;
      }
    },
  );
  app.patch(
    patchRoute.path,
    { ...patchRoute.options, bodyLimit: PATCH_BODY_LIMIT_BYTES },
    patchRoute.handler as Parameters<GuiStoreRouteHost['patch']>[2],
  );
}
