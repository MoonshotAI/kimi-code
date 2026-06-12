import {
  type ServiceIdentifier,
  InstantiationService,
  resolveConfigPath,
  resolveKimiHome,
  setUnexpectedErrorHandler,
} from '@moonshot-ai/agent-core';
import {
  IApprovalService,
  IAuthSummaryService,
  IEnvironmentService,
  IEventService,
  ICoreProcessService,
  IModelCatalogService,
  IMcpService,
  IMessageService,
  IOAuthService,
  IFileStore,
  IFsGitService,
  IFsSearchService,
  IFsService,
  IFsWatcher,
  ILogService,
  IPromptService,
  IQuestionService,
  ISessionService,
  ISkillService,
  ITaskService,
  ITerminalService,
  IToolService,
  IWorkspaceFsService,
  IWorkspaceRegistry,
  FsPathEscapesError,
  FsWatchLimitError,
  FsWatcherService,
  SessionNotFoundError,
  createConnectionLookup,
  resolveSafePath,
  type CoreProcessServiceOptions,
} from '@moonshot-ai/services';
import { ErrorCode, createAsyncApiDocument } from '@moonshot-ai/protocol';
import Fastify from 'fastify';
import { promises as fspPromises } from 'node:fs';
import {
  join as nodePathJoin,
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

  swagger?: boolean;

  swaggerUiAssetsDir?: string;

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
  const swaggerEnabled = opts.swagger === true;

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

  async function registerSwaggerUi(assetsDir: string | undefined): Promise<void> {
    const { default: swaggerUi } = await import('@fastify/swagger-ui');
    const logo =
      assetsDir === undefined
        ? undefined
        : {
            type: 'image/svg+xml',
            content: await fspPromises.readFile(nodePathJoin(assetsDir, 'logo.svg')),
          };

    await app.register(swaggerUi, {
      routePrefix: '/documentation',
      baseDir: assetsDir,
      logo,
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
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

  if (swaggerEnabled) {
    await registerSwaggerUi(opts.swaggerUiAssetsDir);
  }

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

  let address: string;
  try {
    address = await ix.invokeFunction((a) => a.get(IRestGateway).listen(opts.host, opts.port));
  } catch (error) {
    try {
      ix.dispose();
    } catch {

    }
    lockHandle.release();
    throw error;
  }
  pinoLogger.info({ address, lockPath: lockHandle.lockPath }, 'server listening');

  let closed = false;
  return {
    address,
    logger: pinoLogger,
    services: ix,
    close: async () => {
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
    },
  };
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
