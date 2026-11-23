import {
  bootstrap,
  drainQueryStoreDisposals,
  drainSessionMetadataWrites,
  drainSessionIndexMirror,
  drainLogCloses,
  ConfigWarning,
  CapabilityChanged,
  IAppendLogStore,
  IConfigService,
  IEventService,
  IMcpOAuthService,
  IProviderDiscoveryService,
  ISessionIndex,
  ISessionIndexMirror,
  ISessionManager,
  ICapabilityService,
  IPluginService,
  IEnvironmentService,
  IWorkspaceService,
  IAgentLifecycleService,
  IAgentEnvironmentBindingService,
  ISessionContext,
  MAIN_AGENT_ID,
  NOTIFY_USER_UI_CAPABILITY,
  PluginChanged,
  logSeed,
  resolveLoggingConfig,
  type ConfigDiagnostic,
  type Scope,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import {
  createKimiDefaultHeaders,
  KIMI_CODE_PROVIDER_NAME,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-oauth';
import { RemoteEnvironmentProviderFactory } from '@moonshot-ai/agent-core-v2/remote';
import type { FastifyInstance } from 'fastify';

import {
  listenWithPortRetry,
  PORT_RETRY_LIMIT,
  prepareHttpShell,
  type HttpEndpointOptions,
  type ListenWithPortRetryOptions,
} from './httpShell';
import { transformOpenApiDocument } from './openapi/transforms';
import { createAsyncApiDocument } from './protocol/asyncapi';
import { registerApiV1Routes } from './routes/registerApiV1Routes';
import { registerWebAssetRoutes } from './routes/webAssets';
import { drainGlobalSearchDisposals, IGlobalSearchService } from './search/searchService';
import type { IAuthTokenService } from './services/auth/authTokenService';
import { startConfigChangedPublisher } from './services/config/configChangedPublisher';
import { ConversationService } from './services/conversation/conversationService';
import { HostBridgeManager, hostSnapshots } from './services/hosts/hostBridgeManager';
import {
  matchHostProxyPath,
  proxyHostWebSocket,
  registerHostProxyRoutes,
  resolveHostBridgeSession,
} from './services/hosts/hostProxy';
import { DEFAULT_MANAGED_IDLE_EXIT_MS, ManagedIdleExit } from './services/managedIdleExit';
import { ModelCatalogRefreshScheduler } from './services/modelCatalog/modelCatalogRefreshScheduler';
import {
  closeIdleSessions,
  resolveSessionIdleReclaimMs,
  SessionIdleReaper,
} from './services/sessionIdleReaper';
import { createServerSessionRating } from './services/sessionRating';
import {
  initializeServerTelemetry,
  shutdownServerTelemetry,
  type ServerTelemetry,
} from './services/telemetry';
import { isRpcHttpRequest, startUnixRpcServer, type UnixRpcServer } from './transport/stdioRpc';
import {
  ConnectionRegistry,
  type IConnectionRegistry,
} from './transport/ws/connectionRegistry';
import { registerWsDebug, WS_DEBUG_PATH } from './transport/ws/debug/registerWsDebug';
import type { ConfigWarningItem } from './transport/ws/v1/events';
import { registerWsV1, WS_PATH as WS_PATH_V1 } from './transport/ws/v1/registerWsV1';
import { SessionEventBroadcaster } from './transport/ws/v1/sessionEventBroadcaster';

export { listenWithPortRetry, PORT_RETRY_LIMIT };
export type { ListenWithPortRetryOptions };

export interface ServerHostIdentity extends KimiHostIdentity {
  readonly displayName?: string;
  readonly replyStyleGuide?: string;
}

export interface ServerStartOptions extends HttpEndpointOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly pluginMarketplaceUrl?: string;
  readonly debugEndpoints?: boolean;
  readonly seeds?: ScopeSeed;
  readonly hostIdentity: ServerHostIdentity;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: boolean;
  readonly socketPath?: string;
  readonly managedBy?: string;
  readonly managedIdleExitMs?: number;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly core: Scope;
  readonly connectionRegistry: IConnectionRegistry;
  readonly authTokenService: IAuthTokenService;
  readonly hostBridges: HostBridgeManager;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerStartOptions): Promise<RunningServer> {
  const idleReclaimMs = resolveSessionIdleReclaimMs(opts.env ?? process.env);
  const shell = await prepareHttpShell(opts);
  const {
    host,
    homeDir,
    configPath,
    serverVersion,
    exposureClass,
    enableShutdown,
    logger,
    registration,
    authTokenService,
    authFailureLimiter,
    app,
  } = shell;
  const debugEndpoints = exposureClass === 'loopback' && opts.debugEndpoints === true;
  const logging = resolveLoggingConfig({ homeDir, env: process.env });

  const { app: core } = bootstrap(
    {
      homeDir,
      configPath,
      env:
        opts.pluginMarketplaceUrl === undefined
          ? opts.env
          : {
              ...(opts.env ?? process.env),
              KIMI_CODE_PLUGIN_MARKETPLACE_URL: opts.pluginMarketplaceUrl,
            },
      clientIdentity: opts.hostIdentity,
      args: {
        requestHeaders: createKimiDefaultHeaders({ homeDir, ...opts.hostIdentity }),
        skillDirs: opts.skillDirs,
        displayName: opts.hostIdentity.displayName,
        replyStyleGuide: opts.hostIdentity.replyStyleGuide,
        uiCapabilities: [NOTIFY_USER_UI_CAPABILITY],
      },
    },
    [...logSeed(logging), ...(opts.seeds ?? [])],
  );
  const environments = core.accessor.get(IEnvironmentService);
  const remoteEnvironmentProvider = await environments.addProvider(
    new RemoteEnvironmentProviderFactory({
      clientVersion: serverVersion,
    }),
  );
  const legacyAcpBindingSubscription = core.accessor
    .get(ISessionManager)
    .onDidCreateSession?.((event) => {
      const main = event.handle.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      if (main === undefined) return;
      const binding = main.accessor.get(IAgentEnvironmentBindingService);
      const current = binding.current;
      if (
        current.environmentId !== `acp:${event.sessionId}` ||
        environments.current(current.environmentId) !== undefined
      ) {
        return;
      }
      binding.bind('local', current.cwd ?? event.handle.accessor.get(ISessionContext).cwd);
    });

  const remoteControl = shell.createRemoteControl(
    () =>
      core.accessor
        .get(IConfigService)
        .inspect<Record<string, { oauth?: { key: string; oauthHost?: string } }>>('providers')
        .userValue?.[KIMI_CODE_PROVIDER_NAME]?.oauth,
  );

  let telemetry: ServerTelemetry = {};
  if (opts.telemetry === true) {
    try {
      telemetry = await initializeServerTelemetry(core, homeDir);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'telemetry initialization failed; continuing without telemetry',
      );
    }
  }

  const modelCatalogRefreshScheduler = new ModelCatalogRefreshScheduler(
    core.accessor.get(IProviderDiscoveryService),
    core.accessor.get(IConfigService),
    logger,
  );
  const sessionIdleReaper = new SessionIdleReaper(
    core.accessor.get(ISessionManager),
    logger,
    idleReclaimMs,
  );

  try {
    await core.accessor.get(IWorkspaceService).list();
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'workspace catalog startup sync failed',
    );
  }

  try {
    await core.accessor.get(ISessionIndex).prepare();
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'session index prepare failed; falling back to on-demand reads',
    );
  }

  let rpcServer: UnixRpcServer | undefined;
  let closePromise: Promise<void> | undefined;

  const performClose = async (): Promise<void> => {
    await rpcServer?.close();
    if (wssDebug !== undefined) {
      for (const client of wssDebug.clients) client.terminate();
    }
    configChangedPublisher.close();
    await remoteControl.service.close();
    await app.close();
    conversations.dispose();
    sessionRating.dispose();
    configWarningSubscription.dispose();
    pluginChangeSubscription.dispose();
    capabilityInstallSubscription.dispose();
    authFailureLimiter?.dispose();
    modelCatalogRefreshScheduler.dispose();
    if (hostNotifyTimer !== undefined) {
      clearTimeout(hostNotifyTimer);
      hostNotifyTimer = undefined;
    }
    await managedIdleExit?.close();
    hostBridges.close();
    await sessionIdleReaper.close();
    try {
      await shutdownServerTelemetry(telemetry);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'telemetry shutdown failed; continuing server cleanup',
      );
    }
    try {
      await drainSessionMetadataWrites();
      await core.accessor.get(ISessionIndexMirror).drain();
      await core.accessor.get(IMcpOAuthService).shutdown();
      const appendLogStore = core.accessor.get(IAppendLogStore);
      legacyAcpBindingSubscription?.dispose();
      await remoteEnvironmentProvider.dispose();
      core.dispose();
      await appendLogStore.drainRetirements();
      await drainSessionIndexMirror();
      await drainGlobalSearchDisposals();
      await drainQueryStoreDisposals();
      await drainSessionMetadataWrites();
      await drainLogCloses();
    } finally {
      try {
        await registration.release();
      } finally {
        shell.removeProcessHandlers();
      }
    }
  };

  const close = (): Promise<void> => {
    closePromise ??= performClose();
    return closePromise;
  };

  const connectionRegistry = new ConnectionRegistry();
  let notifyHosts = (): void => {};
  let hostNotifyTimer: ReturnType<typeof setTimeout> | undefined;
  const hostBridges = new HostBridgeManager(core, () => notifyHosts());
  const requestClose = (): void => {
    void close().catch((error: unknown) => logger.error({ err: error }, 'server close failed'));
  };
  const sessionManager = core.accessor.get(ISessionManager);
  const otherRpcClientCount = (): number =>
    Math.max(0, (rpcServer?.clientCount() ?? 0) - (isRpcHttpRequest() ? 1 : 0));
  const drainIdleSessions = async (): Promise<boolean> => {
    if (connectionRegistry.size() > 0 || otherRpcClientCount() > 0) return false;
    await closeIdleSessions(sessionManager, 0);
    return (
      connectionRegistry.size() === 0 &&
      otherRpcClientCount() === 0 &&
      sessionManager.list().length === 0
    );
  };
  const managedIdleExit =
    opts.managedBy === undefined
      ? undefined
      : new ManagedIdleExit(
          sessionManager,
          { size: () => connectionRegistry.size() + (rpcServer?.clientCount() ?? 0) },
          opts.managedIdleExitMs ?? DEFAULT_MANAGED_IDLE_EXIT_MS,
          requestClose,
        );
  const conversations = new ConversationService(core);
  const sessionRating = createServerSessionRating(core, { debugEndpoints, logger });
  core.accessor.get(IGlobalSearchService);
  const broadcaster = new SessionEventBroadcaster({
    core,
    logger,
    conversations,
  });
  notifyHosts = () => {
    if (hostNotifyTimer !== undefined) clearTimeout(hostNotifyTimer);
    hostNotifyTimer = setTimeout(() => {
      hostNotifyTimer = undefined;
      broadcaster.publishHostChanged(hostSnapshots(hostBridges));
    }, 10);
    hostNotifyTimer.unref?.();
  };

  const configService = core.accessor.get(IConfigService);
  const publishConfigWarnings = (diagnostics: readonly ConfigDiagnostic[]): void => {
    const warnings: ConfigWarningItem[] = diagnostics.map((diagnostic) =>
      diagnostic.domain === undefined
        ? { message: diagnostic.message }
        : { domain: diagnostic.domain, message: diagnostic.message },
    );
    core.accessor.get(IEventService).publish(new ConfigWarning({ payload: { warnings } }));
  };
  const configWarningSubscription = configService.onDidChangeDiagnostics(publishConfigWarnings);
  const configChangedPublisher = startConfigChangedPublisher(core);

  const pluginService = core.accessor.get(IPluginService);
  const pluginChangeSubscription = pluginService.onDidReload(() => {
    core.accessor.get(IEventService).publish(new PluginChanged({ payload: {} }));
  });
  const capabilityService = core.accessor.get(ICapabilityService);
  const capabilityInstallSubscription = capabilityService.onDidChangeInstall((change) => {
    core.accessor.get(IEventService).publish(
      new CapabilityChanged({
        payload: { capability_id: change.id, install: change.install },
      }),
    );
  });
  void configService.ready
    .then(() => {
      if (configService.diagnostics().length > 0) {
        publishConfigWarnings(configService.diagnostics());
      }
    })
    .catch(() => {});

  async function registerOpenApi(): Promise<void> {
    const { default: swagger } = await import('@fastify/swagger');
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Kimi Code Server API',
          description:
            'REST API for the Kimi Code local server. All JSON responses are wrapped in a uniform envelope `{ code, msg, data, request_id }`.',
          version: serverVersion,
        },
        tags: [
          { name: 'meta', description: 'Server metadata' },
          { name: 'auth', description: 'Auth readiness & login state' },
          { name: 'models', description: 'Configured model aliases' },
          { name: 'providers', description: 'Configured providers' },
          { name: 'sessions', description: 'Session lifecycle' },
          { name: 'workspaces', description: 'Workspace registry + folder picker' },
          { name: 'messages', description: 'Message history' },
          { name: 'search', description: 'Global message search' },
          { name: 'prompts', description: 'Prompt submission & abort' },
          { name: 'interactions', description: 'Approval and question responses' },
          { name: 'tools', description: 'Tool listing' },
          { name: 'mcp', description: 'MCP server registry & OAuth management' },
          { name: 'tasks', description: 'Task management' },
          { name: 'fs', description: 'Filesystem operations' },
          { name: 'files', description: 'File upload & download' },
          { name: 'remote-control', description: 'Remote Control tunnel' },
        ],
      },
      transformObject: (documentObject) => {
        if (!('openapiObject' in documentObject)) {
          return documentObject.swaggerObject;
        }
        return transformOpenApiDocument(documentObject.openapiObject as Record<string, unknown>);
      },
    });
  }

  await registerOpenApi();

  await registerApiV1Routes(app, core, {
    serverId: registration.serverId,
    serverVersion,
    hostIdentity: opts.hostIdentity,
    debugEndpoints,
    enableShutdown,
    remoteControl,
    onShutdown: requestClose,
    drainIdleSessions,
    hostBridges,
    conversations,
    sessionRating,
    dangerousBypassAuth: opts.disableAuth === true,
    managedHost: opts.managedBy === 'ensure-daemon',
    webTitle: opts.webTitle,
  });

  const wssV1 = registerWsV1(core, {
    registry: connectionRegistry,
    broadcaster,
  });
  const wssDebug = debugEndpoints ? registerWsDebug() : undefined;

  shell.installUpgradeGate(
    (url) => {
      const isV1 = url === WS_PATH_V1 || url.startsWith(`${WS_PATH_V1}?`);
      const isDebug = debugEndpoints && (url === WS_DEBUG_PATH || url.startsWith(`${WS_DEBUG_PATH}?`));
      return isV1 || isDebug || matchHostProxyPath(url) !== undefined;
    },
    async (url, req, socket, head) => {
      const isV1 = url === WS_PATH_V1 || url.startsWith(`${WS_PATH_V1}?`);
      const isDebug = url === WS_DEBUG_PATH || url.startsWith(`${WS_DEBUG_PATH}?`);
      const wss = isV1 ? wssV1 : isDebug ? wssDebug : undefined;
      if (wss === undefined) {
        const target = matchHostProxyPath(url);
        if (target !== undefined) {
          await proxyHostWebSocket(hostBridges, target, req, socket, head);
        } else {
          socket.destroy();
        }
        return;
      }
      if (isV1) hostBridges.activate();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
  );

  app.addHook('onClose', async () => {
    connectionRegistry.closeAll('server shutting down');
    wssV1.close();
    wssDebug?.close();
    await broadcaster.close();
  });

  registerHostProxyRoutes(app, hostBridges);

  app.get('/asyncapi.json', async (_req, reply) => {
    return reply
      .type('application/json')
      .send(createAsyncApiDocument({ version: serverVersion, serverHost: host }));
  });

  app.get('/openapi.json', async (_req, reply) => {
    const openApiDocument = (app as unknown as { swagger(): unknown }).swagger();
    return reply.type('application/json').send(openApiDocument);
  });

  if (opts.webAssetsDir !== undefined) {
    await registerWebAssetRoutes(app, opts.webAssetsDir);
  }

  let boundPort = 0;
  try {
    if (opts.socketPath !== undefined) {
      await app.ready();
      rpcServer = await startUnixRpcServer(opts.socketPath, {
        app,
        wssV1,
        wssDebug,
        onV1WsOpen: () => hostBridges.activate(),
        openHostWebSocket: async (path, handlers) => {
          const target = matchHostProxyPath(path);
          if (target === undefined) return undefined;
          const session = await resolveHostBridgeSession(hostBridges, target.hostId);
          return session.openWebSocket(target.path, handlers);
        },
      });
    } else {
      boundPort = await shell.listenTcp();
    }
  } catch (error) {
    try {
      await close();
    } catch {}
    throw error;
  }

  void modelCatalogRefreshScheduler.start().catch((error) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'provider-model catalog auto-refresh failed to start',
    );
  });
  sessionIdleReaper.start();
  managedIdleExit?.start();
  shell.installProcessHandlers();

  return {
    app,
    core,
    connectionRegistry,
    authTokenService,
    hostBridges,
    host,
    port: boundPort,
    close,
  };
}
