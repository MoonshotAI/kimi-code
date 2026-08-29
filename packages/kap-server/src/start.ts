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
  IOAuthService,
  IProviderDiscoveryService,
  ISessionIndex,
  ISessionIndexMirror,
  ICapabilityService,
  IPluginService,
  IWorkspaceService,
  PluginChanged,
  logSeed,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type ConfigDiagnostic,
  type Scope,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import {
  createKimiDefaultHeaders,
  kimiRegionProfile,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-oauth';
import { createAsyncApiDocument } from './protocol/asyncapi';
import Fastify, { type FastifyInstance } from 'fastify';

import { installErrorHandler } from './error-handler';
import { createInstanceRegistry, type InstanceRegistration } from './instanceRegistry';
import { transformOpenApiDocument } from './openapi/transforms';
import { registerRequestLogging } from './requestLogging';
import { resolveRequestId } from './request-id';
import { registerApiV1Routes } from './routes/registerApiV1Routes';
import { registerApiV2Routes } from './routes/registerApiV2Routes';
import { registerWebAssetRoutes } from './routes/webAssets';
import {
  createServerLogger,
  type ServerLogger,
  type ServerLogLevel,
} from './services/pinoLoggerService';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  ConnectionRegistry,
  type IConnectionRegistry,
} from './transport/ws/connectionRegistry';
import { extractWsBearerToken } from './transport/ws/bearerProtocol';
import { SessionEventBroadcaster } from './transport/ws/v1/sessionEventBroadcaster';
import type { ConfigWarningItem } from './transport/ws/v1/events';
import { FsWatchBridge } from './transport/ws/v1/fsWatchBridge';
import { registerWsV1, WS_PATH as WS_PATH_V1 } from './transport/ws/v1/registerWsV1';
import { getServerVersion } from './version';
import { classify } from './security/bindClassify';
import {
  createHostCheck,
  isHostCheckDisabled,
  parseAllowedHosts,
} from './middleware/hostnames';
import { createOriginHook, isOriginAllowed, parseCorsOrigins } from './middleware/origin';
import { createSecurityHeadersHook } from './middleware/securityHeaders';
import { createAuthHook } from './middleware/auth';
import { GuiStoreService } from './services/guiStore/guiStoreService';
import {
  initializeServerTelemetry,
  type ServerTelemetry,
  shutdownServerTelemetry,
} from './services/telemetry';
import { TranscriptService } from './services/transcript/transcriptService';
import { ModelCatalogRefreshScheduler } from './services/modelCatalog/modelCatalogRefreshScheduler';
import { startConfigChangedPublisher } from './services/config/configChangedPublisher';
import { createAuthFailureLimiter } from './middleware/rateLimit';
import {
  createAuthTokenService,
  type IAuthTokenService,
} from './services/auth/authTokenService';
import { createCredentialValidator } from './services/auth/credentials';
import { resolvePasswordHash } from './services/auth/password';
import { createTokenStore } from './services/auth/tokenStore';

import { drainGlobalSearchDisposals, IGlobalSearchService } from './search/searchService';

export interface ServerHostIdentity extends KimiHostIdentity {
  readonly displayName?: string;
  readonly replyStyleGuide?: string;
}

export interface ServerStartOptions {
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pluginMarketplaceUrl?: string;
  readonly configPath?: string;
  readonly instancesDir?: string;
  readonly logLevel?: ServerLogLevel;
  readonly logger?: ServerLogger;
  readonly debugEndpoints?: boolean;
  readonly bindClass?: 'lan' | 'public';
  readonly allowedHosts?: readonly string[];
  readonly corsOrigins?: readonly string[];
  readonly disableHostCheck?: boolean;
  readonly insecureNoTls?: boolean;
  readonly allowRemoteShutdown?: boolean;
  readonly authTokenService?: IAuthTokenService;
  readonly disableAuth?: boolean;
  readonly webTitle?: string;
  readonly rpcToken?: string;
  readonly seeds?: ScopeSeed;
  readonly hostIdentity: ServerHostIdentity;
  readonly skillDirs?: readonly string[];
  readonly webAssetsDir?: string;
  readonly serverVersion?: string;
  readonly telemetry?: boolean;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly core: Scope;
  readonly connectionRegistry: IConnectionRegistry;
  readonly authTokenService: IAuthTokenService;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 58627;

export async function startServer(opts: ServerStartOptions): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const homeDir = resolveKimiHome(opts.homeDir);
  const serverVersion = opts.serverVersion ?? getServerVersion();
  const registry = createInstanceRegistry({
    instancesDir: opts.instancesDir ?? join(homeDir, 'server', 'instances'),
  });
  const registration: InstanceRegistration = await registry.register({
    pid: process.pid,
    host,
    port,
    startedAt: Date.now(),
    serverVersion,
  });
  const exposureClass = classify(host, { bindClass: opts.bindClass });
  if (exposureClass !== 'loopback' && opts.insecureNoTls !== true) {
    await registration.release();
    throw new Error(
      `Refusing to bind ${host} (${exposureClass}) without TLS; terminate TLS at a reverse proxy or pass --insecure-no-tls.`,
    );
  }
  const enableShutdown = exposureClass === 'loopback' || opts.allowRemoteShutdown === true;
  const enableTerminals = exposureClass === 'loopback';
  const debugEndpoints = exposureClass === 'loopback' && opts.debugEndpoints === true;
  const logger = opts.logger ?? createServerLogger({ level: opts.logLevel ?? 'info' });
  const onUnhandledRejection = (reason: unknown): void => {
    logger.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandledRejection',
    );
  };
  const onUncaughtException = (err: unknown): void => {
    logger.fatal(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'uncaughtException',
    );
    process.exit(1);
  };
  const authFailureLimiter =
    exposureClass === 'loopback' ? undefined : createAuthFailureLimiter({ logger });

  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  const guiStore = new GuiStoreService(homeDir, logger);
  let authTokenService: IAuthTokenService;
  let passwordConfigured = false;
  if (opts.authTokenService !== undefined) {
    authTokenService = opts.authTokenService;
  } else {
    const tokenStore = await createTokenStore(homeDir);
    const passwordHash = await resolvePasswordHash();
    passwordConfigured = passwordHash !== undefined;
    authTokenService = createAuthTokenService({ tokenStore, passwordHash });
  }
  const validateCredential = createCredentialValidator(authTokenService, opts.rpcToken);
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  const { app: core } = bootstrap(
    {
      homeDir,
      configPath,
      env: opts.env,
      clientIdentity: opts.hostIdentity,
      args: {
        requestHeaders: createKimiDefaultHeaders({ homeDir, ...opts.hostIdentity }),
        skillDirs: opts.skillDirs,
        displayName: opts.hostIdentity.displayName,
        replyStyleGuide: opts.hostIdentity.replyStyleGuide,
      },
    },
    [...logSeed(logging), ...(opts.seeds ?? [])],
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

  if (exposureClass !== 'loopback') {
    logger.warn(
      { host, exposureClass },
      'binding non-loopback host without TLS — use a reverse proxy or tunnel in production',
    );
    if (!passwordConfigured) {
      logger.warn(
        { host, exposureClass },
        'binding non-loopback host with token-only auth (no KIMI_CODE_PASSWORD) — the bearer token printed in the startup banner is the only credential protecting this server',
      );
    }
  }
  const modelCatalogRefreshScheduler = new ModelCatalogRefreshScheduler(
    core.accessor.get(IProviderDiscoveryService),
    core.accessor.get(IConfigService),
    logger,
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

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
    genReqId: (req) => resolveRequestId(req.headers),
  }) as unknown as FastifyInstance;
  app.server.requestTimeout = 0;
  registerRequestLogging(app);
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installErrorHandler(app);
  const hostCheck = createHostCheck({
    boundHost: host,
    extra: [...parseAllowedHosts(process.env), ...(opts.allowedHosts ?? [])],
    disable: opts.disableHostCheck ?? isHostCheckDisabled(),
  });
  const allowedOrigins = opts.corsOrigins ?? parseCorsOrigins();
  app.addHook('onRequest', hostCheck.onRequest);
  app.addHook('onRequest', createOriginHook({ allowedOrigins }));
  if (opts.disableAuth !== true) {
    app.addHook(
      'onRequest',
      createAuthHook(authTokenService, { limiter: authFailureLimiter, validateCredential }),
    );
  } else {
    logger.warn(
      { host, exposureClass },
      'DANGEROUS: bearer-token auth is DISABLED (--dangerous-bypass-auth) — every REST and WebSocket route accepts unauthenticated requests',
    );
  }
  if (exposureClass !== 'loopback') {
    app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
  }

  const close = async (): Promise<void> => {
    configChangedPublisher.close();
    await app.close();
    configWarningSubscription.dispose();
    pluginChangeSubscription.dispose();
    capabilityInstallSubscription.dispose();
    authFailureLimiter?.dispose();
    modelCatalogRefreshScheduler.dispose();
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
      fsWatchBridge.dispose();
      const appendLogStore = core.accessor.get(IAppendLogStore);
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
        process.off('unhandledRejection', onUnhandledRejection);
        process.off('uncaughtException', onUncaughtException);
      }
    }
  };

  const connectionRegistry = new ConnectionRegistry();
  const transcriptService = new TranscriptService({ homeDir, core, logger });
  core.accessor.get(IGlobalSearchService).setLiveTranscriptSource(transcriptService);
  const broadcaster = new SessionEventBroadcaster({
    eventsDir: join(homeDir, 'server', 'events'),
    core,
    logger,
    transcriptService,
  });
  const fsWatchBridge = new FsWatchBridge({ core, logger });

  const configService = core.accessor.get(IConfigService);
  const publishConfigWarnings = (diagnostics: readonly ConfigDiagnostic[]): void => {
    const warnings: ConfigWarningItem[] = diagnostics
      .filter((diagnostic) => diagnostic.severity === 'warning')
      .map((diagnostic) =>
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
      if (configService.diagnostics().some((diagnostic) => diagnostic.severity === 'warning')) {
        publishConfigWarnings(configService.diagnostics());
      }
    })
    .catch(() => {
    });

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
          { name: 'v2-sessions', description: 'Domain-grouped session list query (API v2)' },
          { name: 'workspaces', description: 'Workspace registry + folder picker' },
          { name: 'messages', description: 'Message history' },
          { name: 'search', description: 'Global message search' },
          { name: 'transcript', description: 'Turn-granular session transcript' },
          { name: 'prompts', description: 'Prompt submission & abort' },
          { name: 'approvals', description: 'Approval resolution' },
          { name: 'questions', description: 'Question resolution & dismiss' },
          { name: 'tools', description: 'Tool & MCP server management' },
          { name: 'tasks', description: 'Task management' },
          { name: 'terminals', description: 'PTY terminal sessions' },
          { name: 'fs', description: 'Filesystem operations' },
          { name: 'files', description: 'File upload & download' },
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
    serverVersion,
    hostIdentity: opts.hostIdentity,
    debugEndpoints,
    enableShutdown,
    enableTerminals,
    guiStore,
    pluginMarketplaceUrl: (() => {
      const configured = opts.pluginMarketplaceUrl ?? process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'];
      if (configured !== undefined) return () => configured;
      return () =>
        `${kimiRegionProfile(core.accessor.get(IOAuthService).getRegion()).cdnBase}/plugins/marketplace.json`;
    })(),
    pluginMarketplaceIsDefault:
      opts.pluginMarketplaceUrl === undefined &&
      (process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'] === undefined ||
        process.env['KIMI_CODE_PLUGIN_MARKETPLACE_FROM_DEV_SERVER'] === '1'),
    onShutdown: () => {
      void close().catch((err: unknown) => logger.error({ err }, 'server close failed'));
    },
    connectionRegistry,
    broadcaster,
    transcriptService,
    dangerousBypassAuth: opts.disableAuth === true,
    webTitle: opts.webTitle,
  });

  await registerApiV2Routes(app, core);

  const wssV1 = registerWsV1(core, {
    validateCredential,
    registry: connectionRegistry,
    broadcaster,
    fsWatchBridge,
    logger,
  });

  const handleUpgrade = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    const url = req.url ?? '';
    const isV1 = url === WS_PATH_V1 || url.startsWith(`${WS_PATH_V1}?`);
    if (!isV1) {
      socket.destroy();
      return;
    }

    if (!hostCheck.isAllowed(req.headers.host)) {
      logger.warn(
        { remoteAddress: req.socket.remoteAddress, path: url, reason: 'host_not_allowed' },
        'ws upgrade rejected',
      );
      (socket as Socket).write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      (socket as Socket).destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin, req.headers.host, allowedOrigins)) {
      logger.warn(
        { remoteAddress: req.socket.remoteAddress, path: url, reason: 'origin_not_allowed' },
        'ws upgrade rejected',
      );
      (socket as Socket).write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      (socket as Socket).destroy();
      return;
    }

    if (opts.disableAuth !== true) {
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
      const protocolToken = extractWsBearerToken(req.headers['sec-websocket-protocol']);
      const candidate = bearerToken !== null && bearerToken.length > 0 ? bearerToken : protocolToken;
      let ok = false;
      if (candidate !== null) {
        try {
          ok = await validateCredential(candidate);
        } catch (error) {
          logger.warn(
            {
              err: error,
              remoteAddress: req.socket.remoteAddress,
              path: url,
              reason: 'credential_validation_error',
            },
            'ws upgrade rejected',
          );
          ok = false;
        }
      }
      if (!ok) {
        logger.warn(
          {
            remoteAddress: req.socket.remoteAddress,
            path: url,
            reason: candidate === null ? 'missing_credential' : 'invalid_credential',
          },
          'ws upgrade rejected',
        );
        (socket as Socket).write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        (socket as Socket).destroy();
        return;
      }
    }

    (socket as Socket).setNoDelay(true);
    wssV1.handleUpgrade(req, socket, head, (ws) => wssV1.emit('connection', ws, req));
  };
  app.server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch((error: unknown) =>
      logger.error({ err: error }, 'ws upgrade handler failed'),
    );
  });

  app.addHook('onClose', async () => {
    connectionRegistry.closeAll('server shutting down');
    wssV1.close();
    await broadcaster.close();
  });

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

  try {
    await listenWithPortRetry({
      listen: (h, p) => app.listen({ host: h, port: p }),
      host,
      port,
      logger,
    });
  } catch (error) {
    try {
      await close();
    } catch {
    }
    throw error;
  }

  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  await registration.update({ port: boundPort });

  void modelCatalogRefreshScheduler.start().catch((error) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'provider-model catalog auto-refresh failed to start',
    );
  });

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);

  return { app, core, connectionRegistry, authTokenService, host, port: boundPort, close };
}

export const PORT_RETRY_LIMIT = 100;

export interface ListenWithPortRetryOptions {
  readonly listen: (host: string, port: number) => Promise<string>;
  readonly host: string;
  readonly port: number;
  readonly logger: ServerLogger;
  readonly maxRetries?: number;
}

export async function listenWithPortRetry(
  opts: ListenWithPortRetryOptions,
): Promise<{ address: string; port: number }> {
  if (opts.port === 0) {
    const address = await opts.listen(opts.host, 0);
    return { address, port: 0 };
  }

  const maxRetries = opts.maxRetries ?? PORT_RETRY_LIMIT;
  let port = opts.port;
  for (let attempt = 0; ; attempt++) {
    try {
      const address = await opts.listen(opts.host, port);
      if (port !== opts.port) {
        opts.logger.warn(
          { requestedPort: opts.port, port, host: opts.host },
          'requested port was busy; server bound to a higher port',
        );
      }
      return { address, port };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || attempt >= maxRetries || port >= 65535) {
        throw error;
      }
      const next = port + 1;
      opts.logger.warn(
        { host: opts.host, port, next },
        'port in use by another process, trying next port',
      );
      port = next;
    }
  }
}
