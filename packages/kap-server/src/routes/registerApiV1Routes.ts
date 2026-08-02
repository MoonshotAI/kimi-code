/**
 * `/api/v1` route registration.
 *
 * Engine mode (the only mode): routes resolve the session surface from the
 * Rust engine session backend (`rustSession`) and host-owned services
 * (workspace registry, file blob store). The v2 Core `Scope` was retired with
 * the engine migration.
 */

import { ulid } from 'ulid';

import { okEnvelope } from '../envelope';
import { type IConnectionRegistry } from '../transport/ws/connectionRegistry';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import type { ServerLogger } from '../services/pinoLoggerService';
import { registerAuthRoute } from './auth';
import { registerConfigRoutes } from './config';
import { registerConnectionsRoutes } from './connections';
import { registerFilesRoutes } from './files';
import { registerFsRoutes } from './fs';
import { registerGuiStoreRoutes } from './guiStore';
import type { IGuiStoreService } from '../services/guiStore/guiStore';
import { registerMetaRoute } from './meta';
import { registerModelCatalogRoutes } from './modelCatalog';
import { registerOAuthRoutes } from './oauth';
import { registerSessionExportRoute } from './sessionExport';
import { registerShutdownRoutes } from './shutdown';
import { registerSnapshotRoutes } from './snapshot';
import { registerSkillsRoutes } from './skills';
import { registerToolsRoutes } from './tools';
import { registerTranscriptRoutes } from './transcript';
import { registerWorkspacesRoutes } from './workspaces';

import type { RustSessionService } from '../services/rustSession/rustSessionService';
import type { FileBlobStore } from '../services/fileBlobStore';
import type { WorkspaceRegistry } from '../services/workspaceRegistry';
import { registerRustSessionsRoutes } from './rustSessions';

interface ApiV1AppHost {
  register(
    plugin: (apiV1: ApiV1RouteHost) => Promise<void> | void,
    opts: { prefix: string },
  ): unknown;
}

interface ApiV1RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: { id: string }, reply: { send(payload: unknown): unknown }) => unknown,
  ): unknown;
}

export interface RegisterApiV1RoutesOptions {
  readonly serverVersion: string;
  readonly enableShutdown?: boolean;
  readonly guiStore: IGuiStoreService;
  readonly onShutdown: () => void;
  readonly connectionRegistry: IConnectionRegistry;
  readonly broadcaster: SessionEventBroadcaster;
  readonly logger: ServerLogger;
  /**
   * Surface `dangerous_bypass_auth` in the `/meta` payload. Set by `start.ts`
   * from the `disableAuth` server option (the `--dangerous-bypass-auth` CLI
   * flag).
   */
  readonly dangerousBypassAuth?: boolean;
  /**
   * Rust engine session backend (the only engine — required).
   */
  readonly rustSession: RustSessionService;
  /** Host-owned workspace registry (stage 3a). */
  readonly workspaceRegistry?: WorkspaceRegistry;
  /** Host-owned file blob store (stage 3b). */
  readonly fileBlobStore: FileBlobStore;
}

export async function registerApiV1Routes(
  app: ApiV1AppHost,
  opts: RegisterApiV1RoutesOptions,
): Promise<void> {
  await app.register(
    async (apiV1) => {
      // Rust engine is the only engine: the session backend is required.
      const rustSession = opts.rustSession;
      if (rustSession === undefined) {
        throw new Error('registerApiV1Routes: rustSession is required (engine is the only engine)');
      }

      registerHealthRoute(apiV1);

      registerMetaRoute(apiV1, {
        serverVersion: opts.serverVersion,
        serverId: ulid(),
        startedAt: new Date().toISOString(),
        dangerousBypassAuth: opts.dangerousBypassAuth === true,
      });

      registerAuthRoute(
        apiV1 as unknown as Parameters<typeof registerAuthRoute>[0],
        rustSession,
      );
      registerOAuthRoutes(
        apiV1 as unknown as Parameters<typeof registerOAuthRoutes>[0],
        rustSession,
      );
      registerConfigRoutes(
        apiV1 as unknown as Parameters<typeof registerConfigRoutes>[0],
        rustSession,
      );
      registerModelCatalogRoutes(
        apiV1 as unknown as Parameters<typeof registerModelCatalogRoutes>[0],
        rustSession,
      );
      registerRustSessionsRoutes(
        apiV1 as unknown as Parameters<typeof registerRustSessionsRoutes>[0],
        rustSession,
      );
      registerSessionExportRoute(
        apiV1 as unknown as Parameters<typeof registerSessionExportRoute>[0],
        { serverVersion: opts.serverVersion, logger: opts.logger },
        rustSession,
      );
      registerSkillsRoutes(
        apiV1 as unknown as Parameters<typeof registerSkillsRoutes>[0],
        rustSession,
        opts.workspaceRegistry,
      );
      registerWorkspacesRoutes(
        apiV1 as unknown as Parameters<typeof registerWorkspacesRoutes>[0],
        rustSession,
        opts.workspaceRegistry,
      );
      registerFilesRoutes(
        apiV1 as unknown as Parameters<typeof registerFilesRoutes>[0],
        opts.fileBlobStore,
      );
      registerFsRoutes(
        apiV1 as unknown as Parameters<typeof registerFsRoutes>[0],
        rustSession,
      );
      registerGuiStoreRoutes(apiV1 as unknown as Parameters<typeof registerGuiStoreRoutes>[0], opts.guiStore);
      registerToolsRoutes(
        apiV1 as unknown as Parameters<typeof registerToolsRoutes>[0],
        rustSession,
      );
      registerConnectionsRoutes(
        apiV1 as unknown as Parameters<typeof registerConnectionsRoutes>[0],
        opts.connectionRegistry,
      );
      registerSnapshotRoutes(apiV1 as unknown as Parameters<typeof registerSnapshotRoutes>[0], {
        rustSession,
      });
      registerTranscriptRoutes(apiV1 as unknown as Parameters<typeof registerTranscriptRoutes>[0], {
        rustSession,
      });
      if (opts.enableShutdown !== false) {
        registerShutdownRoutes(apiV1 as unknown as Parameters<typeof registerShutdownRoutes>[0], {
          onShutdown: opts.onShutdown,
        });
      }
    },
    { prefix: '/api/v1' },
  );
}

function registerHealthRoute(apiV1: ApiV1RouteHost): void {
  apiV1.get(
    '/healthz',
    {
      schema: {
        description: 'Health check',
        response: {
          200: {
            type: 'object',
            properties: {
              code: { type: 'number' },
              msg: { type: 'string' },
              data: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
              },
              request_id: { type: 'string' },
            },
          },
        },
      },
    },
    async (req, reply) => {
      return reply.send(okEnvelope({ ok: true }, req.id));
    },
  );
}
