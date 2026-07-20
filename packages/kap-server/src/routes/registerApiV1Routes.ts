/**
 * `/api/v1` route registration.
 *
 * Mirrors the v1 server's prefixing and per-module delegation, but resolves
 * services from the `agent-core-v2` Core `Scope` instead of the v1 flat
 * `IInstantiationService`. v0.1 mounts the subset of routes that v2 can serve
 * end-to-end today (health, meta, auth readiness, OAuth device flow, config,
 * model/provider catalog, sessions, messages, approvals, workspaces, the fs
 * folder picker, the session filesystem, terminals, connections, shutdown).
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';
import { ulid } from 'ulid';

import { okEnvelope } from '../envelope';
import { type IConnectionRegistry } from '../transport/ws/connectionRegistry';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import type { TranscriptService } from '../services/transcript/transcriptService';
import { registerApprovalsRoutes } from './approvals';
import { registerAuthRoute } from './auth';
import { registerConfigRoutes } from './config';
import { registerConnectionsRoutes } from './connections';
import { registerFilesRoutes } from './files';
import { registerFsRoutes } from './fs';
import { registerGuiStoreRoutes } from './guiStore';
import { registerMessagesRoutes } from './messages';
import type { IGuiStoreService } from '../services/guiStore/guiStore';
import type { ISnapshotReader } from '../services/snapshot';
import { registerDebugRoutes } from '../transport/registerDebugRoutes';
import { registerMetaRoute } from './meta';
import { registerModelCatalogRoutes } from './modelCatalog';
import { registerOAuthRoutes } from './oauth';
import { registerPromptsRoutes } from './prompts';
import { registerQuestionsRoutes } from './questions';
import { registerSessionExportRoute } from './sessionExport';
import { registerSessionsRoutes } from './sessions';
import { registerShutdownRoutes } from './shutdown';
import { registerSnapshotRoutes } from './snapshot';
import { registerSkillsRoutes } from './skills';
import { registerTasksRoutes } from './tasks';
import { registerTerminalsRoutes } from './terminals';
import { registerToolsRoutes } from './tools';
import { registerTranscriptRoutes } from './transcript';
import { registerWorkspaceFsRoutes } from './workspaceFs';
import { registerWorkspacesRoutes } from './workspaces';

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
  readonly debugEndpoints?: boolean;
  readonly enableShutdown?: boolean;
  readonly enableTerminals?: boolean;
  readonly guiStore: IGuiStoreService;
  readonly onShutdown: () => void;
  readonly connectionRegistry: IConnectionRegistry;
  readonly broadcaster: SessionEventBroadcaster;
  readonly snapshotReader: ISnapshotReader;
  readonly transcriptService: TranscriptService;
  /**
   * Surface `dangerous_bypass_auth` in the `/meta` payload. Set by `start.ts`
   * from the `disableAuth` server option (the `--dangerous-bypass-auth` CLI
   * flag).
   */
  readonly dangerousBypassAuth?: boolean;
}

export async function registerApiV1Routes(
  app: ApiV1AppHost,
  core: Scope,
  opts: RegisterApiV1RoutesOptions,
): Promise<void> {
  await app.register(
    async (apiV1) => {
      registerHealthRoute(apiV1);

      // Dev-only debug RPC surface (`--debug-endpoints`, loopback-gated in
      // `start.ts`): every scoped Service reachable.
      if (opts.debugEndpoints === true) {
        registerDebugRoutes(apiV1 as unknown as Parameters<typeof registerDebugRoutes>[0], core);
      }

      registerMetaRoute(apiV1, {
        serverVersion: opts.serverVersion,
        serverId: ulid(),
        startedAt: new Date().toISOString(),
        dangerousBypassAuth: opts.dangerousBypassAuth === true,
      });

      registerAuthRoute(apiV1 as unknown as Parameters<typeof registerAuthRoute>[0], core);
      registerOAuthRoutes(apiV1 as unknown as Parameters<typeof registerOAuthRoutes>[0], core);
      registerConfigRoutes(apiV1 as unknown as Parameters<typeof registerConfigRoutes>[0], core);
      registerModelCatalogRoutes(
        apiV1 as unknown as Parameters<typeof registerModelCatalogRoutes>[0],
        core,
      );
      registerSessionsRoutes(
        apiV1 as unknown as Parameters<typeof registerSessionsRoutes>[0],
        core,
      );
      registerSessionExportRoute(
        apiV1 as unknown as Parameters<typeof registerSessionExportRoute>[0],
        core,
        { serverVersion: opts.serverVersion },
      );
      registerSkillsRoutes(apiV1 as unknown as Parameters<typeof registerSkillsRoutes>[0], core);
      registerMessagesRoutes(
        apiV1 as unknown as Parameters<typeof registerMessagesRoutes>[0],
        core,
      );
      registerTasksRoutes(apiV1 as unknown as Parameters<typeof registerTasksRoutes>[0], core);
      registerApprovalsRoutes(
        apiV1 as unknown as Parameters<typeof registerApprovalsRoutes>[0],
        core,
      );
      registerQuestionsRoutes(
        apiV1 as unknown as Parameters<typeof registerQuestionsRoutes>[0],
        core,
      );
      registerPromptsRoutes(
        apiV1 as unknown as Parameters<typeof registerPromptsRoutes>[0],
        core,
      );
      registerWorkspacesRoutes(
        apiV1 as unknown as Parameters<typeof registerWorkspacesRoutes>[0],
        core,
      );
      registerWorkspaceFsRoutes(
        apiV1 as unknown as Parameters<typeof registerWorkspaceFsRoutes>[0],
        core,
      );
      registerFilesRoutes(apiV1 as unknown as Parameters<typeof registerFilesRoutes>[0], core);
      registerFsRoutes(apiV1 as unknown as Parameters<typeof registerFsRoutes>[0], core);
      registerGuiStoreRoutes(apiV1 as unknown as Parameters<typeof registerGuiStoreRoutes>[0], opts.guiStore);
      registerToolsRoutes(apiV1 as unknown as Parameters<typeof registerToolsRoutes>[0], core);
      if (opts.enableTerminals !== false) {
        registerTerminalsRoutes(
          apiV1 as unknown as Parameters<typeof registerTerminalsRoutes>[0],
          core,
        );
      }
      registerConnectionsRoutes(
        apiV1 as unknown as Parameters<typeof registerConnectionsRoutes>[0],
        opts.connectionRegistry,
      );
      registerSnapshotRoutes(apiV1 as unknown as Parameters<typeof registerSnapshotRoutes>[0], {
        core,
        broadcaster: opts.broadcaster,
        reader: opts.snapshotReader,
      });
      registerTranscriptRoutes(apiV1 as unknown as Parameters<typeof registerTranscriptRoutes>[0], {
        core,
        transcriptService: opts.transcriptService,
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
