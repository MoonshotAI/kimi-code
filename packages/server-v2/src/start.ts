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
  logSeed,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type Scope,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { createAsyncApiDocument } from '@moonshot-ai/protocol';
import Fastify, { type FastifyInstance } from 'fastify';

import { installErrorHandler } from './error-handler';
import { acquireLock, ServerLockedError } from './lock';
import { transformOpenApiDocument } from './openapi/transforms';
import { resolveRequestId } from './request-id';
import { registerApiV1Routes } from './routes/registerApiV1Routes';
// Registers the real `node-pty` `ISessionTerminalBackend`, overriding the
// `SessionNotImplementedTerminalBackend` stub from `agent-core-v2`. Side-effect import.
import './terminal/nodePtyTerminalBackend';
import {
  createServerLogger,
  type ServerLogger,
  type ServerLogLevel,
} from './services/pinoLoggerService';
import { join } from 'node:path';
import type { Socket } from 'node:net';

import { registerRpcRoutes } from './transport/registerRpcRoutes';
import {
  ConnectionRegistry,
  type IConnectionRegistry,
} from './transport/ws/connectionRegistry';
import { registerWs, WS_PATH as WS_PATH_V2 } from './transport/ws/registerWs';
import { extractWsBearerToken } from './transport/ws/bearerProtocol';
import { SessionEventBroadcaster } from './transport/ws/v1/sessionEventBroadcaster';
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
import { createAuthFailureLimiter } from './middleware/rateLimit';
import {
  createAuthTokenService,
  type IAuthTokenService,
} from './services/auth/authTokenService';
import { createCredentialValidator } from './services/auth/credentials';
import { resolvePasswordHash } from './services/auth/password';
import { createTokenStore } from './services/auth/tokenStore';

export interface ServerStartOptions {
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly configPath?: string;
  /** Override the single-instance lock path — used in tests. Defaults to `<homeDir>/server/lock`. */
  readonly lockPath?: string;
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
   * Optional *additional* credential accepted on the `/api/v2` surface (REST +
   * WebSocket) alongside the persistent bearer token. Never required and never
   * the only gate: the persistent token always protects `/api/v2`. Leave unset
   * unless a second, distinct RPC credential is genuinely needed.
   */
  readonly rpcToken?: string;
  /** Extra scope seeds applied at bootstrap (e.g. a host-provided `ISessionModelResolver`). */
  readonly seeds?: ScopeSeed;
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

export { ServerLockedError };

export async function startServer(opts: ServerStartOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const homeDir = resolveKimiHome(opts.homeDir);
  // Single-instance lock (matches v1): two servers on the same homeDir cannot
  // run concurrently. Acquired before bind so a second instance fails fast with
  // `ServerLockedError` rather than racing the port. Released on close and on
  // any boot refusal below.
  const lockHandle = acquireLock({
    port,
    host,
    lockPath: opts.lockPath ?? join(homeDir, 'server', 'lock'),
    hostVersion: getServerVersion(),
    entry: process.argv[1],
  });
  const exposureClass = classify(host, { bindClass: opts.bindClass });
  if (exposureClass !== 'loopback' && opts.insecureNoTls !== true) {
    lockHandle.release();
    throw new Error(
      `Refusing to bind ${host} (${exposureClass}) without TLS; terminate TLS at a reverse proxy or pass --insecure-no-tls.`,
    );
  }
  const enableShutdown = exposureClass === 'loopback' || opts.allowRemoteShutdown === true;
  const enableTerminals = exposureClass === 'loopback' || opts.allowRemoteTerminals === true;
  const debugEndpoints = exposureClass === 'loopback' && opts.debugEndpoints === true;
  const authFailureLimiter = exposureClass === 'loopback' ? undefined : createAuthFailureLimiter();

  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  const guiStore = new GuiStoreService(homeDir);
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
  // for the `/api/v2` surface. The same validator backs the HTTP auth hook,
  // the WS upgrade handler, and the post-connect handshakes so one credential
  // gates all surfaces and upgrade / handshake can never disagree.
  const validateCredential = createCredentialValidator(authTokenService, opts.rpcToken);
  // `ILogOptions` (logSeed) is required by the Session-scoped log writer; any
  // route that creates a session (e.g. POST /sessions) would otherwise fail to
  // instantiate the Session scope. Resolve it from env + homeDir like the CLI.
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  // `bootstrap()` seeds every storage role token (`IStorageService`,
  // `IAtomicDocumentStorage`, `IAppendLogStorage`, `IBlobStorage`) with its own
  // file-backed instance rooted at `homeDir`, so session metadata, wire
  // records, blobs, and the session index all persist to disk.
  const { app: core } = bootstrap({ homeDir, configPath }, [
    ...logSeed(logging),
    ...(opts.seeds ?? []),
  ]);

  const logger = opts.logger ?? createServerLogger({ level: opts.logLevel ?? 'info' });
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
    disableRequestLogging: false,
    genReqId: (req) => resolveRequestId(req.headers),
  }) as unknown as FastifyInstance;
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
  }
  if (exposureClass !== 'loopback') {
    app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
  }

  const close = async (): Promise<void> => {
    await app.close();
    authFailureLimiter?.dispose();
    core.dispose();
    lockHandle.release();
  };

  const connectionRegistry = new ConnectionRegistry();
  const broadcaster = new SessionEventBroadcaster({
    eventsDir: join(homeDir, 'server', 'events'),
    core,
    logger,
  });

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

  // `@fastify/swagger` collects route schemas via an `onRoute` hook, so it must
  // be registered before any routes it should document.
  await registerOpenApi();

  await registerApiV1Routes(app, core, {
    serverVersion,
    debugEndpoints,
    enableShutdown,
    enableTerminals,
    guiStore,
    onShutdown: () => {
      void close();
    },
    connectionRegistry,
    broadcaster,
  });

  registerRpcRoutes(app, core, { token: opts.rpcToken });
  const wssV2 = registerWs(core, { validateCredential, registry: connectionRegistry });
  const wssV1 = registerWsV1(core, {
    validateCredential,
    registry: connectionRegistry,
    broadcaster,
    logger,
  });

  app.server.on('upgrade', async (req, socket, head) => {
    const url = req.url ?? '';
    const isV1 = url === WS_PATH_V1 || url.startsWith(`${WS_PATH_V1}?`);
    const isV2 = url === WS_PATH_V2 || url.startsWith(`${WS_PATH_V2}?`);
    if (!isV1 && !isV2) {
      socket.destroy();
      return;
    }

    // Host / Origin checks (mirror the HTTP `onRequest` hooks). The raw
    // `upgrade` event bypasses Fastify's hooks, so enforce them explicitly
    // here — and BEFORE token validation, matching v1's wsGatewayService.
    // Origin is present-only: a missing Origin is treated as a non-browser
    // client and allowed.
    if (!hostCheck.isAllowed(req.headers.host)) {
      (socket as Socket).write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      (socket as Socket).destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin, req.headers.host, allowedOrigins)) {
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
      // upgrade is rejected with 401 for both `/api/v1/ws` and `/api/v2/ws`.
      let ok = false;
      if (candidate !== null) {
        try {
          ok = await validateCredential(candidate);
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        (socket as Socket).write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        (socket as Socket).destroy();
        return;
      }
    }

    (socket as Socket).setNoDelay(true);
    if (isV1) {
      wssV1.handleUpgrade(req, socket, head, (ws) => wssV1.emit('connection', ws, req));
    } else {
      wssV2.handleUpgrade(req, socket, head, (ws) => wssV2.emit('connection', ws, req));
    }
  });

  app.addHook('onClose', async () => {
    connectionRegistry.closeAll('server shutting down');
    wssV1.close();
    wssV2.close();
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

  // Bind with port+1 retry on EADDRINUSE (mirrors v1). The single-instance
  // lock is acquired above, so any "address in use" here is a third-party
  // listener — never another kimi server — and bumping the port is the desired
  // policy. Port 0 (ephemeral) is never retried.
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
    // lock file, the Core scope, or the background scheduler.
    try {
      await close();
    } catch {
      // best-effort cleanup; the original listen error is what matters
    }
    throw error;
  }

  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  // Advertise the actually-bound port (e.g. ephemeral when `port: 0`) so a
  // status/kill lookup against the lock file finds the real listener.
  lockHandle.updatePort(boundPort);

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
 * Bind the listener, retrying on `port + 1` when the port is held by a
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
