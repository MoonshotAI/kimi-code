/**
 * Server bootstrap — wires the Rust engine session backend and host-owned
 * services into a Fastify HTTP server that speaks the `/api/v1` interface.
 *
 * Composition root: host-owned services are constructed directly; the session
 * surface is served by the Rust engine (`rustSession`). The v2 Core `Scope`
 * (`bootstrap()`) was retired with the engine migration.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { homedir } from 'node:os';

import { createAsyncApiDocument } from './protocol/asyncapi';
import { installErrorHandler } from './error-handler';
import { createInstanceRegistry, type InstanceRegistration } from './instanceRegistry';
import { transformOpenApiDocument } from './openapi/transforms';
import { registerRequestLogging } from './requestLogging';
import { resolveRequestId } from './request-id';
import { registerApiV1Routes } from './routes/registerApiV1Routes';
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

import type { LlmChatRequest, LlmChatResponse } from '@moonshot-ai/kimi-agent/rust-loop';

import {
  ConnectionRegistry,
  type IConnectionRegistry,
} from './transport/ws/connectionRegistry';
import { extractWsBearerToken } from './transport/ws/bearerProtocol';
import { SessionEventBroadcaster } from './transport/ws/v1/sessionEventBroadcaster';
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
import { RustSessionService } from './services/rustSession/rustSessionService';
import { FileBlobStore } from './services/fileBlobStore';
import { WorkspaceRegistry } from './services/workspaceRegistry';
import { createAuthFailureLimiter } from './middleware/rateLimit';
import {
  createAuthTokenService,
  type IAuthTokenService,
} from './services/auth/authTokenService';
import { createCredentialValidator } from './services/auth/credentials';
import { resolvePasswordHash } from './services/auth/password';
import { createTokenStore } from './services/auth/tokenStore';

/**
 * Best-effort Rust session backend: loads rust-loop and returns a
 * RustSessionService when the stdio engine is available, else undefined.
 * The session surface is stdio-only, so the napi fast path is skipped.
 */
async function maybeCreateRustSessionService(
  logger: ServerLogger,
  broadcaster: SessionEventBroadcaster,
  llmStep?: (req: LlmChatRequest) => Promise<LlmChatResponse>,
): Promise<RustSessionService> {
  try {
    // The session-owned surface (`session/*` RPC) is stdio-only — force the
    // binary transport so a present napi addon cannot shadow it.
    process.env['KIMI_AGENT_FORCE_STDIO'] = '1';
    const mod = (await import('@moonshot-ai/kimi-agent/rust-loop')) as typeof import('@moonshot-ai/kimi-agent/rust-loop');
    // Probe: createSessionClient triggers engine init and returns null when
    // the stdio binary is unavailable.
    const probe = await mod.createSessionClient({
      sessionId: `probe-${Date.now().toString(36)}`,
      homedir: process.cwd(),
    });
    if (probe === null) {
      throw new Error(
        '[kimi-agent] Rust engine binary unavailable — web sessions cannot start. ' +
          'Reinstall or rebuild the kimi-agent package.',
      );
    }
    probe.close?.();
    logger.info('Rust engine online — web sessions run on the engine');
    return new RustSessionService(mod, {
      onFrame: (sessionId, frame) => {
        // WS frame fan-out: Rust engine events are projected onto v1 frames
        // and pushed to the session's live WS subscribers (volatile, stamped
        // with the current watermark — they never advance the journal seq).
        broadcaster.broadcastRustFrame(sessionId, frame);
      },
      llmStep,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[kimi-agent]')) {
      throw error;
    }
    throw new Error(
      `[kimi-agent] Rust engine adapter failed to load: ${
        error instanceof Error ? error.message : String(error)
      }`, { cause: error },
    );
  }
}

export interface ServerStartOptions {
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly instancesDir?: string;
  readonly logLevel?: ServerLogLevel;
  readonly logger?: ServerLogger;
  readonly bindClass?: 'lan' | 'public';
  readonly allowedHosts?: readonly string[];
  readonly corsOrigins?: readonly string[];
  readonly disableHostCheck?: boolean;
  readonly insecureNoTls?: boolean;
  readonly allowRemoteShutdown?: boolean;
  readonly authTokenService?: IAuthTokenService;
  readonly disableAuth?: boolean;
  /**
   * Optional *additional* credential accepted on the RPC surface (debug REST +
   * WebSocket) alongside the persistent bearer token. Never required and never
   * the only gate: the persistent token always protects the RPC surface. Leave
   * unset unless a second, distinct RPC credential is genuinely needed.
   */
  readonly rpcToken?: string;
  /**
   * Directory of the built Kimi web UI (`dist-web`). When set, `GET /` and the
   * `/*` SPA fallback serve these assets (auth-exempt, matching v1). Omit to run
   * the API server without the web UI.
   */
  readonly webAssetsDir?: string;
  /**
   * Host product version, reported as `server_version` (GET /api/v1/meta), in
   * the OpenAPI document, session exports, the lock / instance registry, and
   * the default User-Agent. Defaults to kap-server's own package version;
   * embedding hosts (the CLI) should pass their own version.
   */
  readonly version?: string;
  /**
   * Host-proxy LLM step handler for engine turns (tests). When set, every web
   * session's engine turns run through this callback instead of a native HTTP
   * LLM transport — lets tests drive real engine loops with a stub provider.
   */
  readonly llmStep?: (req: LlmChatRequest) => Promise<LlmChatResponse>;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly connectionRegistry: IConnectionRegistry;
  readonly authTokenService: IAuthTokenService;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 58627;

export async function startServer(opts: ServerStartOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const homeDir = resolveKimiHome(opts.homeDir);
  // Instance discovery: every server registers itself under
  // `<home>/server/instances/<serverId>.json`, so multiple servers can share
  // one homeDir and consumers (the CLI's `server ps/kill`, `kimi web`, dev
  // tooling) can discover the live instances. Port conflicts between siblings
  // are resolved by the `port + 1` retry below. The registration is released
  // on close and on any boot refusal below.
  const hostVersion = opts.version ?? getServerVersion();
  const registry = createInstanceRegistry({
    instancesDir: opts.instancesDir ?? join(homeDir, 'server', 'instances'),
  });
  const registration: InstanceRegistration = await registry.register({
    pid: process.pid,
    host,
    port,
    startedAt: Date.now(),
    hostVersion,
  });
  const exposureClass = classify(host, { bindClass: opts.bindClass });
  if (exposureClass !== 'loopback' && opts.insecureNoTls !== true) {
    await registration.release();
    throw new Error(
      `Refusing to bind ${host} (${exposureClass}) without TLS; terminate TLS at a reverse proxy or pass --insecure-no-tls.`,
    );
  }
  const enableShutdown = exposureClass === 'loopback' || opts.allowRemoteShutdown === true;
  const logger = opts.logger ?? createServerLogger({ level: opts.logLevel ?? 'info' });
  const authFailureLimiter =
    exposureClass === 'loopback' ? undefined : createAuthFailureLimiter({ logger });

  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  // Engine mode: point the engine's config resolution at the host's
  // `config.toml` (`KIMI_CONFIG_PATH` is the highest priority in the engine's
  // `find_config_paths`), so `config/get` / `config/set` serve the same file
  // the host manages. The engine process is a module-level singleton, so this
  // must be set before the first engine spawn (the probe below).
  process.env['KIMI_CONFIG_PATH'] = configPath;
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
    authFailureLimiter?.dispose();
    await registration.release();
  };

  const connectionRegistry = new ConnectionRegistry();
  const workspaceRegistry = new WorkspaceRegistry(homeDir);
  const fileBlobStore = new FileBlobStore(homeDir);
  const broadcaster = new SessionEventBroadcaster({
    eventsDir: join(homeDir, 'server', 'events'),
    logger,
    // Engine is the only engine (missing binary fails startup): serve the
    // Rust session subscriptions with ephemeral states, skip the v2 bus.
    rustOnly: true,
  });
  // Rust-engine session backend (web sessions bound to engine-owned sessions).
  // The Rust engine is the only engine — a missing binary fails startup loudly
  // instead of silently serving from the v2-backed JS routes.
  const rustSession = await maybeCreateRustSessionService(logger, broadcaster, opts.llmStep);

  const fsWatchBridge = new FsWatchBridge({
    logger,
  });

  const serverVersion = hostVersion;

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

  await registerApiV1Routes(app, {
    serverVersion,
    enableShutdown,
    guiStore,
    onShutdown: () => {
      void close().catch((error: unknown) => logger.error({ error }, 'server close failed'));
    },
    connectionRegistry,
    broadcaster,
    logger,
    dangerousBypassAuth: opts.disableAuth === true,
    rustSession,
    workspaceRegistry,
    fileBlobStore,
  });

  const wssV1 = registerWsV1({
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

  return { app, connectionRegistry, authTokenService, host, port: boundPort, close };
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

/**
 * Resolve the Kimi home directory: explicit option, `KIMI_CODE_HOME` env, or
 * `<osHome>/.kimi-code` (localized from the retired `agent-core-v2` bootstrap).
 */
function resolveKimiHome(homeDir?: string): string {
  return homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

/** Resolve the config file path: explicit option or `<home>/config.toml`. */
function resolveConfigPath(input: { readonly homeDir?: string; readonly configPath?: string }): string {
  return input.configPath ?? join(resolveKimiHome(input.homeDir), 'config.toml');
}
