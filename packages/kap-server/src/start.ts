/**
 * Server bootstrap — wires `@moonshot-ai/agent-core-v2` (DI × Scope engine) into
 * a Fastify HTTP server that speaks the same `/api/v1` interface as the v1
 * server.
 *
 * Composition root: `bootstrap()` builds the Core `Scope`; route handlers resolve
 * Core-scoped services through `core.accessor.get(IXxx)`.
 */

import {
  bootstrap,
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  IConfigService,
  IEventService,
  IProviderDiscoveryService,
  ISessionIndex,
  ISessionIndexMirror,
  IWorkspaceService,
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
import { createAuthFailureLimiter } from './middleware/rateLimit';
import {
  createAuthTokenService,
  type IAuthTokenService,
} from './services/auth/authTokenService';
import { createCredentialValidator } from './services/auth/credentials';
import { resolvePasswordHash } from './services/auth/password';
import { createTokenStore } from './services/auth/tokenStore';

// Temporary feature: global message search. Importing this module registers
// `IGlobalSearchService` (App scope) into the DI registry as a side effect, so
// it MUST stay above any `bootstrap()` call — registration happens at module
// evaluation time.
import { drainGlobalSearchDisposals, IGlobalSearchService } from './search/searchService';

export interface ServerHostIdentity extends KimiHostIdentity {
  /** Fills the `${product_name}` slot in the base system prompt. Defaults render the CLI text. */
  readonly displayName?: string;
  /** Replaces the `${reply_style_guide}` block in the base system prompt. */
  readonly replyStyleGuide?: string;
}

export interface ServerStartOptions {
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly configPath?: string;
  /**
   * Override the instance-registry directory — used in tests that need the
   * registry OUTSIDE `homeDir` (e.g. folder-picker fixtures browsing the home
   * dir). Defaults to `<homeDir>/server/instances`.
   */
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
  readonly allowRemoteTerminals?: boolean;
  readonly authTokenService?: IAuthTokenService;
  readonly disableAuth?: boolean;
  /**
   * Optional *additional* credential accepted on the RPC surface (debug REST +
   * WebSocket) alongside the persistent bearer token. Never required and never
   * the only gate: the persistent token always protects the RPC surface. Leave
   * unset unless a second, distinct RPC credential is genuinely needed.
   */
  readonly rpcToken?: string;
  /** Extra scope seeds applied at bootstrap (e.g. a host-provided `ISessionModelResolver`). */
  readonly seeds?: ScopeSeed;
  /**
   * Identity of the host product embedding the server: feeds the engine's
   * `bootstrap()` client identity, the default outbound request headers
   * (User-Agent + `X-Msh-*` via `createKimiDefaultHeaders`), and the session
   * export manifest. Applied to every agent and request the server hosts —
   * required, so every host states its own product name, version, and
   * platform explicitly.
   */
  readonly hostIdentity: ServerHostIdentity;
  /**
   * Explicit skill directories for this process (v1's SDK `skillDirs`): when
   * non-empty, default user / project skill discovery is skipped and these
   * directories serve as the user skill source for every session. Applied to
   * all sessions the server hosts — for embedding hosts, not per-session use.
   */
  readonly skillDirs?: readonly string[];
  /**
   * Directory of the built Kimi web UI (`dist-web`). When set, `GET /` and the
   * `/*` SPA fallback serve these assets (auth-exempt, matching v1). Omit to run
   * the API server without the web UI.
   */
  readonly webAssetsDir?: string;
  /**
   * Engine version, reported as `server_version` (GET /api/v1/meta), in the
   * OpenAPI document, and in the lock / instance registry. Defaults to
   * kap-server's own package version; the host product version travels in
   * `hostIdentity.version` instead.
   */
  readonly serverVersion?: string;
  /**
   * Opt-in cloud telemetry for the engine's `ITelemetryService` events: when
   * true, a `CloudAppender` is attached at startup (still gated by the config
   * `telemetry` toggle) and flushed on close. Defaults to false so tests and
   * embedding hosts that wire their own telemetry never post to the real
   * endpoint unintentionally; the CLI's `kimi web` host passes true.
   */
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
  // Instance discovery: every server registers itself under
  // `<home>/server/instances/<serverId>.json`, so multiple servers can share
  // one homeDir and consumers (the CLI's `server ps/kill`, `kimi web`, dev
  // tooling) can discover the live instances. Port conflicts between siblings
  // are resolved by the `port + 1` retry below. The registration is released
  // on close and on any boot refusal below.
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
  const enableTerminals = exposureClass === 'loopback' || opts.allowRemoteTerminals === true;
  const debugEndpoints = exposureClass === 'loopback' && opts.debugEndpoints === true;
  const logger = opts.logger ?? createServerLogger({ level: opts.logLevel ?? 'info' });
  const authFailureLimiter =
    exposureClass === 'loopback' ? undefined : createAuthFailureLimiter({ logger });

  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  const guiStore = new GuiStoreService(homeDir, logger);
  let authTokenService: IAuthTokenService;
  // Whether a password credential is configured (only meaningful for the real,
  // non-injected auth impl). Drives the token-only warning on a public bind.
  let passwordConfigured = false;
  if (opts.authTokenService !== undefined) {
    authTokenService = opts.authTokenService;
  } else {
    const tokenStore = await createTokenStore(homeDir);
    const passwordHash = await resolvePasswordHash();
    passwordConfigured = passwordHash !== undefined;
    authTokenService = createAuthTokenService({ tokenStore, passwordHash });
  }
  // Unified credential: the persistent token (or password) protects every
  // route; the optional `rpcToken` is accepted as an additional credential
  // for the RPC surface. The same validator backs the HTTP auth hook,
  // the WS upgrade handler, and the post-connect handshakes so one credential
  // gates all surfaces and upgrade / handshake can never disagree.
  const validateCredential = createCredentialValidator(authTokenService, opts.rpcToken);
  // `ILogOptions` (logSeed) is required by the Session-scoped log writer; any
  // route that creates a session (e.g. POST /sessions) would otherwise fail to
  // instantiate the Session scope. Resolve it from env + homeDir like the CLI.
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  // `bootstrap()` seeds `IFileSystemStorageService` with a `FileStorageService`
  // rooted at `homeDir`, so the Store facades above it (append-log, atomic
  // document, blob) — and in turn session metadata, wire records, blobs, and
  // the session index — all persist to disk.
  const { app: core } = bootstrap(
    {
      homeDir,
      configPath,
      clientIdentity: opts.hostIdentity,
      args: {
        // Default host identity headers derived from `hostIdentity`: outbound
        // requests (model, WebSearch, registry refresh) carry the host
        // product's User-Agent + X-Msh-* set.
        requestHeaders: createKimiDefaultHeaders({ homeDir, ...opts.hostIdentity }),
        skillDirs: opts.skillDirs,
        displayName: opts.hostIdentity.displayName,
        replyStyleGuide: opts.hostIdentity.replyStyleGuide,
      },
    },
    [...logSeed(logging), ...(opts.seeds ?? [])],
  );

  // Attach the cloud telemetry appender BEFORE any session is created:
  // `session_started` / `session_load_failed` fire inside create()/resume(), so
  // an appender wired later would drop them to the null appender. Opt-in via
  // `opts.telemetry` (off by default so tests never post to the real endpoint);
  // best-effort — telemetry must never block server boot.
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

  // Sync the workspace catalog from the legacy session index once at startup,
  // so sessions created by the v1 TUI surface as workspaces on the very first
  // /workspaces request. Awaited so the write completes before the server
  // starts accepting traffic (and before embedding hosts tear the homeDir
  // down); best-effort: a failure re-surfaces on first access.
  try {
    await core.accessor.get(IWorkspaceService).list();
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'workspace catalog startup sync failed',
    );
  }

  // Prepare the session read model before serving traffic (flag-gated; a
  // no-op when `persistence_minidb_readmodel` is off): opens the query store,
  // restores the published generation — running the initial projection when
  // none exists — and starts background reconciliation, so the first request
  // never pays the open/rebuild cost.
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
    // Fastify's default access log records `res.statusCode`, but every
    // kap-server response is HTTP 200 by design — the outcome lives in the
    // envelope `code`. `registerRequestLogging` emits our own line instead.
    disableRequestLogging: true,
    genReqId: (req) => resolveRequestId(req.headers),
  }) as unknown as FastifyInstance;
  registerRequestLogging(app);
  // Validation is performed by the route-level Zod preHandlers (defineRoute),
  // not by Fastify's AJV layer — keep both compilers as pass-throughs.
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
    // `--dangerous-bypass-auth`: the operator explicitly disabled the
    // bearer-token gate on every REST and WebSocket route. Warn loudly —
    // especially on a non-loopback bind, where this grants unauthenticated
    // remote session / filesystem / shell access to anyone who can reach the
    // port. The `/api/v1/meta` payload advertises the state so the web UI can
    // connect without a token.
    logger.warn(
      { host, exposureClass },
      'DANGEROUS: bearer-token auth is DISABLED (--dangerous-bypass-auth) — every REST and WebSocket route accepts unauthenticated requests',
    );
  }
  if (exposureClass !== 'loopback') {
    app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
  }

  const close = async (): Promise<void> => {
    await app.close();
    configWarningSubscription.dispose();
    authFailureLimiter?.dispose();
    modelCatalogRefreshScheduler.dispose();
    // Telemetry is best-effort and must never prevent core or instance cleanup.
    try {
      await shutdownServerTelemetry(telemetry);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'telemetry shutdown failed; continuing server cleanup',
      );
    }
    try {
      // Drain the session-index mirror while the query store is still open:
      // requests have stopped, so no new summaries arrive and the queue just
      // needs its final flush to land in the read model.
      await core.accessor.get(ISessionIndexMirror).drain();
      core.dispose();
      // `core.dispose()` runs the mirror's, the search service's and the query
      // store's synchronous `dispose()`, whose drains/closes are asynchronous —
      // await them before releasing the instance registration (and before
      // embedding hosts tear down homeDir).
      await drainSessionIndexMirror();
      await drainGlobalSearchDisposals();
      await drainQueryStoreDisposals();
    } finally {
      await registration.release();
    }
  };

  const connectionRegistry = new ConnectionRegistry();
  const transcriptService = new TranscriptService({ homeDir, core, logger });
  // The global search service is DI-managed (App scope) while the transcript
  // service is constructed here by hand — wire the former to the latter so
  // container-scoped searches on live sessions scan the in-memory transcript.
  core.accessor.get(IGlobalSearchService).setLiveTranscriptSource(transcriptService);
  const broadcaster = new SessionEventBroadcaster({
    eventsDir: join(homeDir, 'server', 'events'),
    core,
    logger,
    transcriptService,
  });
  const fsWatchBridge = new FsWatchBridge({ core, logger });

  // Push config warnings (deprecated keys / env vars in use, invalid sections)
  // to every WS connection as `event.config.warning` whenever the config
  // service's warning set changes. The broadcaster fans the DomainEvent out
  // globally (see `onCoreEvent`); delivery is live-only, so the current set is
  // also published once config is ready for already-connected clients (an
  // empty initial set publishes nothing — silence already means no warnings).
  const configService = core.accessor.get(IConfigService);
  const publishConfigWarnings = (diagnostics: readonly ConfigDiagnostic[]): void => {
    const warnings: ConfigWarningItem[] = diagnostics
      .filter((diagnostic) => diagnostic.severity === 'warning')
      .map((diagnostic) =>
        diagnostic.domain === undefined
          ? { message: diagnostic.message }
          : { domain: diagnostic.domain, message: diagnostic.message },
      );
    core.accessor.get(IEventService).publish({
      type: 'event.config.warning',
      payload: { warnings },
    });
  };
  const configWarningSubscription = configService.onDidChangeDiagnostics(publishConfigWarnings);
  void configService.ready
    .then(() => {
      if (configService.diagnostics().some((diagnostic) => diagnostic.severity === 'warning')) {
        publishConfigWarnings(configService.diagnostics());
      }
    })
    .catch(() => {
      /* config readiness is best-effort; warnings are advisory */
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
          { name: 'v2-sessions', description: 'Session list query (API v2, envelope-free)' },
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

  // `@fastify/swagger` collects route schemas via an `onRoute` hook, so it must
  // be registered before any routes it should document.
  await registerOpenApi();

  await registerApiV1Routes(app, core, {
    serverVersion,
    hostIdentity: opts.hostIdentity,
    debugEndpoints,
    enableShutdown,
    enableTerminals,
    guiStore,
    onShutdown: () => {
      void close().catch((err: unknown) => logger.error({ err }, 'server close failed'));
    },
    connectionRegistry,
    broadcaster,
    transcriptService,
    dangerousBypassAuth: opts.disableAuth === true,
  });

  // `/api/v2` — envelope-free surface (raw payloads, real HTTP statuses).
  // Mounted after v1; the root auth/host/origin hooks cover it identically.
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

    // Host / Origin checks (mirror the HTTP `onRequest` hooks). The raw
    // `upgrade` event bypasses Fastify's hooks, so enforce them explicitly
    // here — and BEFORE token validation, matching v1's wsGatewayService.
    // Origin is present-only: a missing Origin is treated as a non-browser
    // client and allowed.
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
      // Require a valid credential at the upgrade: a token-less (or invalid)
      // upgrade is rejected with 401 for `/api/v1/ws`.
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
    // Reflect the bound host, never the caller-supplied `Host` header (Host
    // reflection is an information-leak / SSRF-adjacent hole once the server is
    // reachable beyond localhost). Gated by the global auth hook (meta doc).
    return reply
      .type('application/json')
      .send(createAsyncApiDocument({ version: serverVersion, serverHost: host }));
  });

  app.get('/openapi.json', async (_req, reply) => {
    const openApiDocument = (app as unknown as { swagger(): unknown }).swagger();
    return reply.type('application/json').send(openApiDocument);
  });

  // Web UI static assets (mirrors v1). Registered LAST so the `/*` SPA fallback
  // only catches paths not already handled by `/api/*`, `/openapi.json`, or
  // `/asyncapi.json`. The global auth hook already bypasses non-`/api` paths, so
  // the page loads without a token; API calls carry it.
  if (opts.webAssetsDir !== undefined) {
    await registerWebAssetRoutes(app, opts.webAssetsDir);
  }

  // Bind with port+1 retry on EADDRINUSE (mirrors v1). Port 0 (ephemeral) is
  // never retried.
  //
  // There is no single-instance lock: a busy port may be a sibling kimi
  // instance sharing this homeDir (each registers itself under
  // `<home>/server/instances/`), and the `port + 1` walk is exactly how the
  // second instance yields to 58628 (and so on) — the retry doubles as the
  // multi-instance coexistence mechanism. A busy port held by a third-party
  // listener gets the same treatment, matching the v1 policy.
  try {
    await listenWithPortRetry({
      listen: (h, p) => app.listen({ host: h, port: p }),
      host,
      port,
      logger,
    });
  } catch (error) {
    // Listen failed even after the port walk (or for a non-EADDRINUSE reason).
    // Tear down what boot already assembled so a failed start does not leak the
    // instance registration, the Core scope, or the refresh scheduler.
    try {
      await close();
    } catch {
      // best-effort cleanup; the original listen error is what matters
    }
    throw error;
  }

  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  // Advertise the actually-bound port (e.g. ephemeral when `port: 0`, or the
  // `port + 1` retry winner) so a status/kill lookup against the instance
  // registry finds the real listener.
  await registration.update({ port: boundPort });

  void modelCatalogRefreshScheduler.start().catch((error) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'provider-model catalog auto-refresh failed to start',
    );
  });

  return { app, core, connectionRegistry, authTokenService, host, port: boundPort, close };
}

/**
 * Maximum consecutive `EADDRINUSE` retries when the requested port is busy.
 * Caps the `port + 1` walk so a permanently-saturated range cannot loop
 * forever; 100 matches the v1 server's `PORT_RETRY_LIMIT` and the daemon
 * spawner's own scan window.
 */
export const PORT_RETRY_LIMIT = 100;

export interface ListenWithPortRetryOptions {
  /**
   * Bind attempt — typically `app.listen`. Called with `(host, port)` and
   * resolves with the bound address string on success, or rejects with an
   * `EADDRINUSE` `ErrnoException` when the port is held.
   */
  readonly listen: (host: string, port: number) => Promise<string>;
  readonly host: string;
  readonly port: number;
  readonly logger: ServerLogger;
  /** Override the retry cap — used by tests to keep the walk short. */
  readonly maxRetries?: number;
}

/**
 * Bind the listener, retrying on `port + 1` when the port is held.
 *
 * Why this is the right layer: there is no single-instance lock — every
 * kap-server registers itself under `<home>/server/instances/` instead, so a
 * busy port may be a sibling kimi instance. The `port + 1` walk then serves
 * as the multi-instance coexistence mechanism (the second instance lands on
 * the next free port), and a third-party listener gets the same "port busy ⇒
 * +1" policy as v1.
 *
 * Port `0` (OS-assigned ephemeral) is never retried: the kernel already picks a
 * free port, so `EADDRINUSE` cannot arise from a specific-port conflict.
 */
export async function listenWithPortRetry(
  opts: ListenWithPortRetryOptions,
): Promise<{ address: string; port: number }> {
  // Ephemeral bind: the OS chooses a free port, so there is nothing to retry.
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
