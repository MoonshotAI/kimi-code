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
import { createAuthFailureLimiter } from '#/middleware/rateLimit';
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
import { IModelCatalogRefreshScheduler } from '#/services/modelCatalog/modelCatalogRefreshScheduler';
import {
  createAuthTokenService,
  IAuthTokenService,
} from '#/services/auth/authTokenService';
import { classify } from '#/services/auth/bindClassify';
import { resolvePasswordHash } from '#/services/auth/password';
import { createSecurityHeadersHook } from '#/services/auth/securityHeaders';
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

  /**
   * Override the classification of a wildcard bind (`0.0.0.0` / `::` / empty).
   * Default (unset) treats wildcards as `public` (most strict); set to `lan`
   * to relax to LAN-tier hardening. See `services/auth/bindClassify.ts`.
   */
  bindClass?: 'lan' | 'public';

  /**
   * Allow a non-loopback bind WITHOUT a TLS-terminating reverse proxy. Default
   * false: binding beyond loopback refuses to start unless this is set, so a
   * public/LAN bind is never served over plain HTTP by accident. Pass
   * `--insecure-no-tls` (or set this) only when you accept the risk.
   */
  insecureNoTls?: boolean;

  /**
   * Allow `POST /api/v1/shutdown` on a non-loopback bind. Default false: the
   * shutdown route is NOT registered (404) on a public/LAN bind unless this is
   * set. Loopback always mounts it.
   */
  allowRemoteShutdown?: boolean;

  /**
   * Allow the PTY `/api/v1/terminals/*` routes on a non-loopback bind. Default
   * false: terminals routes are NOT registered (404) on a public/LAN bind
   * unless this is set (remote shell is the highest-risk surface). Loopback
   * always mounts them.
   */
  allowRemoteTerminals?: boolean;

  webAssetsDir?: string;

  /**
   * Extra `Host` header values to allow, in addition to the default allowlist
   * and `KIMI_CODE_ALLOWED_HOSTS`. A leading dot matches a domain suffix.
   */
  allowedHosts?: readonly string[];

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
  const allowedHosts = [...parseAllowedHosts(process.env), ...(opts.allowedHosts ?? [])];
  const hostCheck = createHostCheck({
    boundHost: opts.host,
    extra: allowedHosts,
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
  // async-built `TokenStore` over the persistent `<homeDir>/server.token`
  // (0600; generated once on first boot and reused across restarts) and an
  // optional bcrypt password hash — both awaited here, then supplied to the
  // collection via `serviceOverrides` so tests can inject a fixed-token impl
  // that wins (last-wins) over this default. The store re-reads the file when
  // its mtime changes, so `kimi server rotate-token` takes effect without a
  // restart; the file is intentionally kept on shutdown (dispose is a no-op).
  const tokenStore = await createTokenStore(envService.homeDir);
  const passwordHash = await resolvePasswordHash(process.env);
  const defaultAuth = createAuthTokenService({ tokenStore, passwordHash });

  // Public-bind hardening gate (ROADMAP M6.3). Classify the bind host and, for
  // any non-loopback tier (LAN or public), refuse to start unless the operator
  // explicitly acknowledged that TLS is terminated elsewhere (`insecureNoTls`).
  // Auth is bearer-token based: the persistent token is printed in the startup
  // banner and reused across restarts, so a password is no longer mandatory for
  // a non-loopback bind — `KIMI_CODE_PASSWORD` remains an optional additional
  // credential. Failing here (before the container is built and before we
  // listen) keeps a public/LAN bind from ever serving plain HTTP by accident.
  // On refusal we release the lock so the operator can retry cleanly.
  const bindClass = classify(opts.host, { bindClass: opts.bindClass });
  if (bindClass !== 'loopback') {
    const refusePublicBind = async (message: string): Promise<never> => {
      try {
        await tokenStore.dispose();
      } catch {
        // best-effort cleanup of the token file on boot refusal
      }
      lockHandle.release();
      throw new Error(message);
    };
    if (opts.insecureNoTls !== true) {
      await refusePublicBind(
        'Refusing to bind a non-loopback host without TLS. ' +
          'Put the server behind a TLS-terminating reverse proxy (Caddy/nginx), ' +
          'or pass --insecure-no-tls to acknowledge the risk.',
      );
    }
    if (passwordHash === undefined) {
      pinoLogger.warn(
        { host: opts.host, bindClass },
        'binding non-loopback host with token-only auth (no KIMI_CODE_PASSWORD) — the bearer token printed in the startup banner is the only credential protecting this server',
      );
    }
    pinoLogger.warn(
      { host: opts.host, bindClass },
      'binding non-loopback host without TLS — use a reverse proxy or tunnel in production',
    );
  }

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
          extra: allowedHosts,
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
  //
  // Auth-failure rate limit (ROADMAP M6.4): only on a non-loopback bind, where
  // brute-force attempts are reachable from the network. Loopback keeps the
  // original "no limiter" behavior so local retries are never throttled.
  const authTokenService = ix.invokeFunction((a) => a.get(IAuthTokenService));
  const authFailureLimiter =
    bindClass !== 'loopback' ? createAuthFailureLimiter() : undefined;
  app.addHook('onRequest', createAuthHook(authTokenService, { limiter: authFailureLimiter }));

  // Security response headers (ROADMAP M6.6): only on a non-loopback bind.
  // TLS is terminated by a reverse proxy in this phase, so HSTS is omitted
  // here (`tls: false`) — the proxy is responsible for setting it.
  if (bindClass !== 'loopback') {
    app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
  }

  // Bind classification (`bindClass`, computed above next to the password/TLS
  // gate) drives every hardening decision from here on: debug routes now;
  // rate limit, dangerous endpoints, and security headers in M6.4–M6.6.

  // Debug routes (ROADMAP M5.3): only mount `/api/v1/debug/*` when bound to a
  // loopback interface. On a non-loopback bind these introspection/mutation
  // endpoints would be reachable from the network, so suppress them even if
  // the caller asked for them, and warn so the operator knows.
  if (opts.debugEndpoints === true && bindClass !== 'loopback') {
    pinoLogger.warn(
      { host: opts.host, bindClass },
      'debug endpoints suppressed: refusing to mount /api/v1/debug/* on a non-loopback bind',
    );
  }

  // Dangerous-endpoint downgrade (ROADMAP M6.5): on a non-loopback bind the
  // shutdown + terminals routes are NOT registered (404) unless the operator
  // explicitly opts in. Loopback always mounts them (backward compatible).
  const allowRemoteShutdown = opts.allowRemoteShutdown === true;
  const allowRemoteTerminals = opts.allowRemoteTerminals === true;
  await registerApiV1Routes(app, ix, {
    serverVersion,
    debugEndpoints: opts.debugEndpoints === true && bindClass === 'loopback',
    enableShutdown: bindClass === 'loopback' || allowRemoteShutdown,
    enableTerminals: bindClass === 'loopback' || allowRemoteTerminals,
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

      // Start the background provider-model refresh scheduler (reads config to
      // decide interval / refresh-on-start). Must run after IModelCatalogService
      // and ICoreProcessService are constructed. Fire-and-forget: the initial
      // refresh is async and must not block boot.
      const catalogScheduler = a.get(IModelCatalogRefreshScheduler);
      catalogScheduler
        .start()
        .catch((err) =>
          log.error({ err }, 'failed to start provider-model refresh scheduler'),
        );

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
      await coreProcess.closeAllSessions();
    } catch (error) {
      pinoLogger.warn(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'failed to close live sessions during server shutdown',
      );
    }

    try {
      ix.dispose();
    } catch {

    }

    // The persistent token is intentionally left on disk so it survives the
    // next start (ROADMAP M5.1). dispose() is a no-op for the persistent store;
    // the call is kept so the interface is honored uniformly and a test
    // override can still observe shutdown.
    try {
      await tokenStore.dispose();
    } catch {
      // ignore — token file may already be gone
    }

    // Stop the auth-failure limiter's cleanup timer (ROADMAP M6.4). Only set
    // on non-loopback binds; the `?.` is a no-op on loopback.
    authFailureLimiter?.dispose();

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
