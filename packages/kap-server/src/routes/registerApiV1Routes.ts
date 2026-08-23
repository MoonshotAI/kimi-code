import { IConfigService, type Scope } from '@moonshot-ai/agent-core-v2';
import { FiberState } from '@moonshot-ai/agent-core-v2/_base/di/fiber';
import { IFeatureManager } from '@moonshot-ai/agent-core-v2/app/feature/featureManager';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import type { KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';
import { ulid } from 'ulid';

import { okEnvelope } from '../envelope';
import type { MetaFeature } from '../protocol/rest-meta';
import { type IConnectionRegistry } from '../transport/ws/connectionRegistry';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import type { TranscriptService } from '../services/transcript/transcriptService';
import { registerApprovalsRoutes } from './approvals';
import { registerAuthRoute } from './auth';
import { registerCapabilitiesRoutes } from './capabilities';
import { registerConfigRoutes } from './config';
import { registerConnectionsRoutes } from './connections';
import { registerFilesRoutes } from './files';
import { registerFsRoutes } from './fs';
import { registerGuiStoreRoutes } from './guiStore';
import { registerMessagesRoutes } from './messages';
import type { IGuiStoreService } from '../services/guiStore/guiStore';
import { registerDebugRoutes } from '../transport/registerDebugRoutes';
import { registerMetaRoute } from './meta';
import { registerModelCatalogRoutes } from './modelCatalog';
import { registerOAuthRoutes } from './oauth';
import { registerPluginsRoutes } from './plugins';
import { registerPromptsRoutes } from './prompts';
import { registerQuestionsRoutes } from './questions';
import { registerRuntimeRoutes } from './runtime';
import { registerSearchRoutes } from './search';
import { registerSessionMediaRoutes } from './sessionMedia';
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
  /**
   * Host product identity from `startServer` — the session export route stamps
   * its manifest from `hostIdentity.version`.
   */
  readonly hostIdentity: KimiHostIdentity;
  readonly debugEndpoints?: boolean;
  readonly enableShutdown?: boolean;
  readonly enableTerminals?: boolean;
  readonly guiStore: IGuiStoreService;
  readonly onShutdown: () => void;
  readonly connectionRegistry: IConnectionRegistry;
  readonly broadcaster: SessionEventBroadcaster;
  readonly transcriptService: TranscriptService;
  /** Catalog URL resolver for the `/plugins/marketplace` route (start.ts
      applies the option/env override; the default follows the active login
      region per request). */
  readonly pluginMarketplaceUrl: () => string;
  /** True when the catalog URL is the built-in default (no option/env set). */
  readonly pluginMarketplaceIsDefault: boolean;
  /**
   * Surface `dangerous_bypass_auth` in the `/meta` payload. Set by `start.ts`
   * from the `disableAuth` server option (the `--dangerous-bypass-auth` CLI
   * flag).
   */
  readonly dangerousBypassAuth?: boolean;
  /**
   * Custom browser tab title for this instance, surfaced as `web_title` in the
   * `/meta` payload. Set by `start.ts` from the `webTitle` server option (the
   * CLI's `--web-title` flag).
   */
  readonly webTitle?: string;
}

export async function registerApiV1Routes(
  app: ApiV1AppHost,
  core: Scope,
  opts: RegisterApiV1RoutesOptions,
): Promise<void> {
  await app.register(
    async (apiV1) => {
      registerHealthRoute(apiV1);

      if (opts.debugEndpoints === true) {
        registerDebugRoutes(apiV1 as unknown as Parameters<typeof registerDebugRoutes>[0], core);
      }

      registerMetaRoute(apiV1, {
        serverVersion: opts.serverVersion,
        serverId: ulid(),
        startedAt: new Date().toISOString(),
        dangerousBypassAuth: opts.dangerousBypassAuth === true,
        webTitle: opts.webTitle,
        getExperimentalFlags: async () => {
          await core.accessor.get(IConfigService).ready;
          return core.accessor.get(IFlagService).snapshot();
        },
        getFeatures: () =>
          core.accessor
            .get(IFeatureManager)
            .units()
            .map((unit) => ({
              name: unit.name,
              state: FiberState[unit.state] as MetaFeature['state'],
              meta: unit.meta,
            })),
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
      registerRuntimeRoutes(apiV1 as unknown as Parameters<typeof registerRuntimeRoutes>[0], core);
      registerSessionExportRoute(
        apiV1 as unknown as Parameters<typeof registerSessionExportRoute>[0],
        core,
        { hostIdentity: opts.hostIdentity },
      );
      registerSkillsRoutes(apiV1 as unknown as Parameters<typeof registerSkillsRoutes>[0], core);
      registerCapabilitiesRoutes(
        apiV1 as unknown as Parameters<typeof registerCapabilitiesRoutes>[0],
        core,
      );
      registerPluginsRoutes(apiV1 as unknown as Parameters<typeof registerPluginsRoutes>[0], core, {
        marketplaceUrl: opts.pluginMarketplaceUrl,
        marketplaceIsDefault: opts.pluginMarketplaceIsDefault,
      });
      registerMessagesRoutes(
        apiV1 as unknown as Parameters<typeof registerMessagesRoutes>[0],
        core,
      );
      registerSearchRoutes(apiV1 as unknown as Parameters<typeof registerSearchRoutes>[0], core);
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
      registerSessionMediaRoutes(
        apiV1 as unknown as Parameters<typeof registerSessionMediaRoutes>[0],
        core,
      );
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
