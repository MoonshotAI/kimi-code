import { InstantiationService, resolveConfigPath, resolveKimiHome, setUnexpectedErrorHandler, IApprovalService, IAuthSummaryService, IEnvironmentService, IEventService, ICoreProcessService, IModelCatalogService, IMcpService, IMessageService, IOAuthService, IFileStore, IFsGitService, IFsSearchService, IFsService, IFsWatcher, ILogService, IPromptService, IQuestionService, ISessionService, ISkillService, ITaskService, ITerminalService, IToolService, IWorkspaceFsService, IWorkspaceRegistry, FsPathEscapesError, FsWatchLimitError, FsWatcherService, SessionNotFoundError, createConnectionLookup, resolveSafePath, type ServiceIdentifier, type CoreProcessServiceOptions } from '@moonshot-ai/agent-core';
import { ErrorCode, createAsyncApiDocument } from '@moonshot-ai/protocol';
import Fastify from 'fastify';
import { promises as fspPromises } from 'node:fs';
import {
  sep as nodePathSep,
  relative as nodePathRelativeNative,
} from 'node:path';

import { installErrorHandler } from './error-handler';
import { transformOpenApiDocument } from './openapi/transforms';
import { acquireLock, ServerLockedError } from './lock';
import { createAuthHook } from '#/middleware/auth';
import {
  createHostCheck,
  isHostCheckDisabled,
  parseAllowedHosts,
} from '#/middleware/hostnames';
import { createOriginHook, parseCorsOrigins } from '#/middleware/origin';
import {
  createServerLogger,
  type ServerLogLevel,
  type ServerLogger,
} from './services/pinoLoggerService';
import { resolveRequestId } from './request-id';
import { registerApiV1Routes } from './routes/registerApiV1Routes';
import {
  IConnectionRegistry,
  IRestGateway,
  IServerShutdownService,
  ISessionClientsService,
  IWSBroadcastService,
  IWSGateway,
  type WSGatewayOptions,
} from '#/services/gateway';
import { createServerServiceCollection } from '#/services/serviceCollection';
import { ISnapshotService, loadSnapshotConfig } from '#/services/snapshot';
import {
  createAuthTokenService,
  IAuthTokenService,
} from '#/services/auth/authTokenService';
import { resolvePasswordHash } from '#/services/auth/password';
import { createTokenStore } from '#/services/auth/tokenStore';
import { getServerVersion } from './version';
import { registerWebAssetRoutes } from './routes/webAssets';

export interface ServerStartOptions {
  host: string;
  port: number;
  logLevel?: ServerLogLevel;

  logger?: ServerLogger;

  lockPath?: string;

  coreProcessOptions?: CoreProcessServiceOptions;

  wsGatewayOptions?: WSGatewayOptions;

  debugEndpoints?: boolean;

  webAssetsDir?: string;

  serviceOverrides?: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>;
}

export interface RunningServer {

  readonly address: string;

  readonly logger: ServerLogger;

  readonly services: InstantiationService;

  close(): Promise<void>;
}

export { ServerLockedError };

export async function startServer(opts: ServerStartOptions): Promise<RunningServer> {
  const pinoLogger: ServerLogger =
    opts.logger ?? createServerLogger({ level: opts.logLevel ?? 'info' });

  const lockHandle = acquireLock({
    port: opts.port,
    host: opts.host,
    lockPath: opts.lockPath,
    // Record the host build identity so `kimi server status` can detect a
    // build-mismatched server.
    hostVersion: opts.coreProcessOptions?.identity?.version,
    entry: process.argv[1],
  });

  const app = Fastify({
    loggerInstance: pinoLogger,
    disableRequestLogging: false,
    genReqId: (req) => resolveRequestId(req.headers),
  });

  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installErrorHandler(app);

  // Host / Origin checks (ROADMAP M4.3). Registered before any route so they
  // run ahead of every handler and ahead of the (future, M5.1) auth hook.
  // Host is evaluated before Origin; both are uniform across bindings (PLAN
  // D3) — even on loopback — so behavior does not depend on how the server is
  // reached. The default-allow set keeps `app.inject` (`Host: localhost:80`)
  // and real `fetch` to `127.0.0.1:<port>` working.
  const hostCheck = createHostCheck({
    boundHost: opts.host,
    extra: parseAllowedHosts(process.env),
    disable: isHostCheckDisabled(process.env),
  });
  const originHook = createOriginHook({ allowedOrigins: parseCorsOrigins(process.env) });
  app.addHook('onRequest', hostCheck.onRequest);
  app.addHook('onRequest', originHook);

  const serverVersion = opts.coreProcessOptions?.identity?.version ?? getServerVersion();

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
          { name: 'prompts', description: 'Prompt submission & abort' },
          { name: 'approvals', description: 'Approval resolution' },
          { name: 'questions', description: 'Question resolution & dismiss' },
          { name: 'tools', description: 'Tool & MCP server management' },
          { name: 'tasks', description: 'Background tasks' },
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

  const envService: IEnvironmentService = {
    _serviceBrand: undefined,
    homeDir: resolveKimiHome(opts.coreProcessOptions?.homeDir),
    configPath: resolveConfigPath({
      homeDir: opts.coreProcessOptions?.homeDir,
      configPath: opts.coreProcessOptions?.configPath,
    }),
  };

  // Token auth (ROADMAP M5.1). The real `IAuthTokenService` needs an
  // async-built `TokenStore` (writes `<homeDir>/server-<pid>.token` at 0600)
  // and an optional bcrypt password hash — both awaited here, then supplied to
  // the collection via `serviceOverrides` so tests can inject a fixed-token
  // impl that wins (last-wins) over this default. The token file is disposed
  // (best-effort) on shutdown and on every boot-error path below.
  const tokenStore = await createTokenStore(envService.homeDir, process.pid);
  const passwordHash = await resolvePasswordHash(process.env);
  const defaultAuth = createAuthTokenService({ tokenStore, passwordHash });

  const services = createServerServiceCollection({
    server: {
      ...opts,
      // WS Host/Origin defaults (ROADMAP M4.3 / M5.1): mirror the HTTP checks
      // on the upgrade path. Caller-supplied values win (used by the
      // host-origin e2e tests). `authTokenService` is NOT threaded here — it
      // reaches the WS gateway via `setAuthTokenService` below so the
      // override-aware impl enforces auth.
      wsGatewayOptions: {
        ...opts.wsGatewayOptions,
        hostCheck: opts.wsGatewayOptions?.hostCheck ?? {
          boundHost: opts.host,
          extra: parseAllowedHosts(process.env),
          disable: isHostCheckDisabled(process.env),
        },
        allowedOrigins:
          opts.wsGatewayOptions?.allowedOrigins ?? parseCorsOrigins(process.env),
      },
      serviceOverrides: [
        [IAuthTokenService, defaultAuth],
        ...(opts.serviceOverrides ?? []),
      ],
    },
    app,
    pinoLogger,
    envService,
  });
  const ix = new InstantiationService(services);

  // Auth hook (ROADMAP M5.1). Registered after Host/Origin (above) and before
  // routes, so a rejected request never reaches a handler. Resolved from the
  // container so a test-injected fixed-token impl is what enforces auth.
  const authTokenService = ix.invokeFunction((a) => a.get(IAuthTokenService));
  app.addHook('onRequest', createAuthHook(authTokenService));

  // Debug routes (ROADMAP M5.3): only mount `/api/v1/debug/*` when bound to a
  // loopback interface. On a non-loopback bind these introspection/mutation
  // endpoints would be reachable from the network, so suppress them even if
  // the caller asked for them, and warn so the operator knows. M6 will replace
  // this inline check with `bindClassify`.
  const isLoopback =
    opts.host === '127.0.0.1' || opts.host === '::1' || opts.host === 'localhost';
  if (opts.debugEndpoints === true && !isLoopback) {
    pinoLogger.warn(
      { host: opts.host },
      'debug endpoints suppressed: refusing to mount /api/v1/debug/* on a non-loopback bind',
    );
  }

  await registerApiV1Routes(app, ix, {
    serverVersion,
    debugEndpoints: opts.debugEndpoints === true && isLoopback,
  });

  app.get('/asyncapi.json', async (_req, reply) => {
    // Reflect the bound host, never the caller-supplied `Host` header (PLAN
    // §3.6-3: Host-header reflection is an information-leak / SSRF-adjacent
    // hole once the server is reachable beyond localhost).
    return reply.type('application/json').send(
      createAsyncApiDocument({ version: serverVersion, serverHost: opts.host }),
    );
  });
  app.get('/openapi.json', async (_req, reply) => {
    const openApiDocument = (app as unknown as { swagger(): unknown }).swagger();
    return reply.type('application/json').send(openApiDocument);
  });

  if (opts.webAssetsDir !== undefined) {
    await registerWebAssetRoutes(app, opts.webAssetsDir);
  }

  try {
    await app.ready();
  } catch (error) {
    try {
      await tokenStore.dispose();
    } catch {
      // best-effort cleanup of the token file on boot failure
    }
    lockHandle.release();
    throw error;
  }

  let coreProcess: ICoreProcessService;
  try {
    coreProcess = ix.invokeFunction((a) => {

      const log = a.get(ILogService);
      a.get(IRestGateway);

      setUnexpectedErrorHandler((err) => {
        log.error(
          err instanceof Error ? { msg: err.message, stack: err.stack } : { err },
          '[unexpected]',
        );
      });

      a.get(IConnectionRegistry);

      a.get(ISessionClientsService);

      a.get(IEventService);

      const wsBroadcast = a.get(IWSBroadcastService);

      a.get(IApprovalService);
      a.get(IQuestionService);

      // Eagerly instantiate the snapshot reader so its event-bus subscription
      // is in place before any session can publish `turn.started` events —
      // lazy-loading would drop turn lifecycle state for sessions created
      // before the first snapshot request.
      if (loadSnapshotConfig().mode !== 'legacy') {
        a.get(ISnapshotService);
      }

      const wsGw = a.get(IWSGateway);

      // Hand the override-aware auth impl to the WS gateway so the upgrade
      // path enforces the same token the HTTP hook uses (ROADMAP M5.1).
      wsGw.setAuthTokenService(authTokenService);

      const built = a.get(ICoreProcessService);

      const sessionService = a.get(ISessionService);
      a.get(IMessageService);

      a.get(IAuthSummaryService);

      a.get(IOAuthService);

      a.get(IModelCatalogService);

      const promptService = a.get(IPromptService);
      const terminalService = a.get(ITerminalService);

      wsGw.setAbortHandler({
        abort: (sid, pid) => promptService.abort(sid, pid),
        currentSeq: (sid) => wsBroadcast.currentSeq(sid),
      });
      wsGw.setTerminalHandler({
        attach: (sessionId, terminalId, sink, options) =>
          terminalService.attach(sessionId, terminalId, sink, options),
        detach: (sessionId, terminalId, sinkId) =>
          terminalService.detach(sessionId, terminalId, sinkId),
        cleanupConnection: (sinkId) => terminalService.detachAllForSink(sinkId),
        write: (sessionId, terminalId, data) =>
          terminalService.write(sessionId, terminalId, data),
        resize: (sessionId, terminalId, cols, rows) =>
          terminalService.resize(sessionId, terminalId, cols, rows),
        close: (sessionId, terminalId) => terminalService.close(sessionId, terminalId),
      });

      a.get(IToolService);
      a.get(IMcpService);
      a.get(ISkillService);

      a.get(ITaskService);

      a.get(IFsService);

      a.get(IFsSearchService);

      a.get(IFsGitService);

      const registry = a.get(IConnectionRegistry);
      const fsWatcher = ix.createInstance(
        FsWatcherService,
        createConnectionLookup((id) => registry.get(id)),
        {},
      );
      services.set(IFsWatcher, fsWatcher);
      a.get(IFsWatcher);

      const fsWatchHandler = {
        async add(sessionId: string, connectionId: string, wirePaths: readonly string[]) {
          try {
            const session = await sessionService.get(sessionId);

            const realCwd = await fspPromises.realpath(session.metadata.cwd);

            fsWatcher.bindSessionCwd(sessionId, realCwd);
            const absPaths: string[] = [];
            for (const p of wirePaths) {
              const safe = await resolveSafePath(session.metadata.cwd, p);
              absPaths.push(safe.absolute);
            }
            fsWatcher.addPaths(sessionId, connectionId, absPaths);
            const watched = fsWatcher.watchedPaths(connectionId, sessionId);

            const wire = watched.map((abs) => toPosixRelativeForCwd(realCwd, abs));
            return {
              ok: true as const,
              watched_paths: wire,
              current_count: fsWatcher.countForConnection(connectionId),
            };
          } catch (error) {
            return mapFsWatchError(error);
          }
        },
        async remove(sessionId: string, connectionId: string, wirePaths: readonly string[]) {
          try {
            const session = await sessionService.get(sessionId);
            const realCwd = await fspPromises.realpath(session.metadata.cwd);
            const absPaths: string[] = [];
            for (const p of wirePaths) {

              const safe = await resolveSafePath(session.metadata.cwd, p);
              absPaths.push(safe.absolute);
            }
            fsWatcher.removePaths(sessionId, connectionId, absPaths);
            const watched = fsWatcher.watchedPaths(connectionId, sessionId);
            const wire = watched.map((abs) => toPosixRelativeForCwd(realCwd, abs));
            return {
              ok: true as const,
              watched_paths: wire,
              current_count: fsWatcher.countForConnection(connectionId),
            };
          } catch (error) {
            return mapFsWatchError(error);
          }
        },
        cleanupConnection(connectionId: string) {
          fsWatcher.forgetConnection(connectionId);
        },
      };
      wsGw.setFsWatchHandler(fsWatchHandler);

      a.get(IFileStore);

      a.get(IWorkspaceRegistry);

      a.get(IWorkspaceFsService);

      return built;
    });
  } catch (error) {

    try {
      ix.dispose();
    } catch {

    }
    try {
      await tokenStore.dispose();
    } catch {
      // best-effort cleanup of the token file on boot failure
    }
    lockHandle.release();
    throw error;
  }

  try {
    await coreProcess.ready();
  } catch (error) {
    try {
      ix.dispose();
    } catch {

    }
    try {
      await tokenStore.dispose();
    } catch {
      // best-effort cleanup of the token file on boot failure
    }
    lockHandle.release();
    throw error;
  }
  pinoLogger.info('core process ready');

  const restGateway = ix.invokeFunction((a) => a.get(IRestGateway));
  let address: string;
  let boundPort: number;
  try {
    ({ address, port: boundPort } = await listenWithPortRetry({
      gateway: restGateway,
      host: opts.host,
      port: opts.port,
      logger: pinoLogger,
    }));
  } catch (error) {
    try {
      ix.dispose();
    } catch {

    }
    try {
      await tokenStore.dispose();
    } catch {
      // best-effort cleanup of the token file on boot failure
    }
    lockHandle.release();
    throw error;
  }
  // If we retried onto a different port, advertise the real one in the lock so
  // `kimi server status` / `kill` / `ps` can find this daemon.
  if (boundPort !== opts.port) {
    lockHandle.updatePort(boundPort);
  }
  pinoLogger.info(
    { address, port: boundPort, lockPath: lockHandle.lockPath },
    'server listening',
  );

  let closed = false;
  const doClose = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    try {
      ix.invokeFunction((a) => a.get(IWSGateway));

      ix.invokeFunction((a) => a.get(IConnectionRegistry).closeAll('server shutting down'));
    } catch {

    }

    try {
      await app.close();
    } catch {

    }

    try {
      ix.dispose();
    } catch {

    }

    // Remove the on-disk token file now that the server is gone (ROADMAP M5.1).
    // Best-effort: a missing/unwritable file must not keep shutdown from
    // releasing the lock.
    try {
      await tokenStore.dispose();
    } catch {
      // ignore — token file may already be gone
    }

    lockHandle.release();
  };

  // Expose process-terminating shutdown to routes via DI. Respect a
  // `serviceOverrides` entry so tests can observe the request without exiting.
  const hasShutdownOverride = opts.serviceOverrides?.some(
    ([id]) => id === IServerShutdownService,
  );
  if (!hasShutdownOverride) {
    services.set(IServerShutdownService, {
      _serviceBrand: undefined,
      requestShutdown: async (reason: string) => {
        pinoLogger.info({ reason }, 'server shutdown requested');
        await doClose();
        process.exit(0);
      },
    });
  }

  return {
    address,
    logger: pinoLogger,
    services: ix,
    close: doClose,
  };
}

/**
 * Maximum consecutive `EADDRINUSE` retries when the requested port is busy.
 * Caps the `port + 1` walk so a permanently-saturated range cannot loop
 * forever; 100 matches the daemon spawner's own scan window in `resolveDaemonPort`.
 */
export const PORT_RETRY_LIMIT = 100;

export interface ListenWithPortRetryOptions {
  gateway: IRestGateway;
  host: string;
  port: number;
  logger: ServerLogger;
  /** Override the retry cap — used by tests to keep the walk short. */
  maxRetries?: number;
}

/**
 * Bind the gateway, retrying on `port + 1` when the port is held by a
 * third-party process.
 *
 * Why this is the right layer: {@link startServer} acquires the single-instance
 * lock *before* listening, so by the time we reach `listen` a live kimi server
 * would already have thrown `ServerLockedError`. Any `EADDRINUSE` here is
 * therefore a third-party listener, and bumping the port is the desired policy
 * ("if the port is taken by something other than kimi server itself, +1").
 *
 * Port `0` (OS-assigned ephemeral) is never retried: the kernel already picks a
 * free port, so `EADDRINUSE` cannot arise from a specific-port conflict.
 */
export async function listenWithPortRetry(
  opts: ListenWithPortRetryOptions,
): Promise<{ address: string; port: number }> {
  // Ephemeral bind: the OS chooses a free port, so there is nothing to retry.
  if (opts.port === 0) {
    const address = await opts.gateway.listen(opts.host, 0);
    return { address, port: 0 };
  }

  const maxRetries = opts.maxRetries ?? PORT_RETRY_LIMIT;
  let port = opts.port;
  for (let attempt = 0; ; attempt++) {
    try {
      const address = await opts.gateway.listen(opts.host, port);
      if (port !== opts.port) {
        opts.logger.warn(
          { requestedPort: opts.port, port, host: opts.host },
          'requested port was busy; server bound to a higher port',
        );
      }
      return { address, port };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || attempt >= maxRetries || port >= 65535) {
        throw err;
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

function toPosixRelativeForCwd(cwd: string, abs: string): string {
  if (abs === cwd) return '.';
  const rel = nodePathRelativeNative(cwd, abs);
  if (rel === '') return '.';
  return rel.split(nodePathSep).join('/');
}

function mapFsWatchError(err: unknown):
  | { ok: false; code: number; msg: string } {
  if (err instanceof FsWatchLimitError) {
    return {
      ok: false,
      code: ErrorCode.FS_WATCH_LIMIT_EXCEEDED,
      msg: err.message,
    };
  }
  if (err instanceof FsPathEscapesError) {
    return {
      ok: false,
      code: ErrorCode.FS_PATH_ESCAPES_SESSION,
      msg: err.message,
    };
  }
  if (err instanceof SessionNotFoundError) {
    return {
      ok: false,
      code: ErrorCode.SESSION_NOT_FOUND,
      msg: 'session not found',
    };
  }
  return {
    ok: false,
    code: ErrorCode.INTERNAL_ERROR,
    msg: err instanceof Error ? err.message : 'fs watch error',
  };
}
