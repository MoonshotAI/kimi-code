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

  const serverVersion = getServerVersion();

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

  const services = createServerServiceCollection({
    server: opts,
    app,
    pinoLogger,
    envService,
  });
  const ix = new InstantiationService(services);

  await registerApiV1Routes(app, ix, {
    serverVersion,
    debugEndpoints: opts.debugEndpoints,
  });

  app.get('/asyncapi.json', async (req, reply) => {
    const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
    return reply.type('application/json').send(
      createAsyncApiDocument({
        version: serverVersion,
        serverHost: host,
      }),
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

      const wsGw = a.get(IWSGateway);

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
