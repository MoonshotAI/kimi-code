import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import { resolveConfigPath, resolveKimiHome } from '@moonshot-ai/agent-core-v2';
import type { KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';
import {
  createRemoteControlManager,
  RemoteControlDeviceClient,
  type RemoteControlManager,
} from '@moonshot-ai/remote-control';
import Fastify, { type FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import { installErrorHandler } from './error-handler';
import { createInstanceRegistry, type InstanceRegistration } from './instanceRegistry';
import { createAuthHook } from './middleware/auth';
import {
  createHostCheck,
  isHostCheckDisabled,
  parseAllowedHosts,
} from './middleware/hostnames';
import { createOriginHook, isOriginAllowed, parseCorsOrigins } from './middleware/origin';
import { createAuthFailureLimiter, type AuthFailureLimiter } from './middleware/rateLimit';
import { createSecurityHeadersHook } from './middleware/securityHeaders';
import { resolveRequestId } from './request-id';
import { registerRequestLogging } from './requestLogging';
import { assertWebAssets } from './routes/webAssets';
import { classify, type BindClass } from './security/bindClassify';
import {
  createAuthTokenService,
  createEphemeralAuthTokenService,
  type IAuthTokenService,
} from './services/auth/authTokenService';
import { createCredentialValidator } from './services/auth/credentials';
import { resolvePasswordHash } from './services/auth/password';
import { createTokenStore } from './services/auth/tokenStore';
import {
  createServerLogger,
  type ServerLogger,
  type ServerLogLevel,
} from './services/pinoLoggerService';
import { extractWsBearerToken } from './transport/ws/bearerProtocol';
import { getServerVersion } from './version';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 58627;
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

export interface HttpEndpointOptions {
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly instancesDir?: string;
  readonly skipInstanceRegistry?: boolean;
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
  readonly webTitle?: string;
  readonly rpcToken?: string;
  readonly webAssetsDir?: string;
  readonly serverVersion?: string;
}

export interface HttpShellOptions extends HttpEndpointOptions {
  readonly socketPath?: string;
  readonly hostIdentity: KimiHostIdentity;
}

export interface ManagedOAuthRef {
  readonly key?: string;
  readonly oauthHost?: string;
}

export interface RemoteControlBundle {
  readonly service: RemoteControlManager;
  readonly devices: RemoteControlDeviceClient;
  readonly homeDir: string;
  readonly staticEnableError?: string;
}

export interface PreparedHttpShell {
  readonly host: string;
  readonly requestedPort: number;
  readonly homeDir: string;
  readonly configPath: string;
  readonly serverVersion: string;
  readonly exposureClass: BindClass;
  readonly enableShutdown: boolean;
  readonly logger: ServerLogger;
  readonly registration: InstanceRegistration;
  readonly authTokenService: IAuthTokenService;
  readonly authFailureLimiter?: AuthFailureLimiter;
  readonly app: FastifyInstance;
  boundPort(): number;
  createRemoteControl(readManagedOAuth: () => ManagedOAuthRef | undefined): RemoteControlBundle;
  installUpgradeGate(
    canUpgrade: (url: string) => boolean,
    performUpgrade: (
      url: string,
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => Promise<void> | void,
  ): void;
  listenTcp(): Promise<number>;
  installProcessHandlers(): void;
  removeProcessHandlers(): void;
}

export async function prepareHttpShell(opts: HttpShellOptions): Promise<PreparedHttpShell> {
  const host = opts.host ?? DEFAULT_HOST;
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const homeDir = resolveKimiHome(opts.homeDir);
  const serverVersion = opts.serverVersion ?? getServerVersion();
  const disableAuth = opts.disableAuth === true || opts.socketPath !== undefined;
  const exposureClass = classify(host, { bindClass: opts.bindClass });
  if (exposureClass !== 'loopback' && opts.insecureNoTls !== true) {
    throw new Error(
      `Refusing to bind ${host} (${exposureClass}) without TLS; terminate TLS at a reverse proxy or pass --insecure-no-tls.`,
    );
  }
  if (opts.webAssetsDir !== undefined) {
    await assertWebAssets(opts.webAssetsDir);
  }
  const enableShutdown = exposureClass === 'loopback' || opts.allowRemoteShutdown === true;
  const logger = opts.logger ?? createServerLogger({ level: opts.logLevel ?? 'info' });
  const onUnhandledRejection = (reason: unknown): void => {
    logger.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandledRejection',
    );
  };
  const onUncaughtException = (err: unknown): void => {
    logger.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'uncaughtException',
    );
  };
  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });

  let authTokenService: IAuthTokenService;
  let passwordConfigured = false;
  if (opts.authTokenService !== undefined) {
    authTokenService = opts.authTokenService;
  } else if (opts.socketPath !== undefined) {
    authTokenService = createEphemeralAuthTokenService();
  } else {
    const tokenStore = await createTokenStore(homeDir);
    const passwordHash = await resolvePasswordHash();
    passwordConfigured = passwordHash !== undefined;
    authTokenService = createAuthTokenService({ tokenStore, passwordHash });
  }
  const validateCredential = createCredentialValidator(authTokenService, opts.rpcToken);
  const registration: InstanceRegistration =
    opts.socketPath !== undefined
      ? { serverId: 'socket', update: async () => {}, release: async () => {} }
      : opts.skipInstanceRegistry === true
        ? { serverId: ulid(), update: async () => {}, release: async () => {} }
        : await createInstanceRegistry({
            instancesDir: opts.instancesDir ?? join(homeDir, 'server', 'instances'),
          }).register({
            pid: process.pid,
            host,
            port: requestedPort,
            startedAt: Date.now(),
            serverVersion,
            product: opts.hostIdentity.productName,
          });
  const authFailureLimiter =
    exposureClass === 'loopback' ? undefined : createAuthFailureLimiter({ logger });

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

  let currentPort = requestedPort;
  const localOriginHost = host.includes(':') ? `[${host}]` : host;

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
  if (!disableAuth) {
    app.addHook(
      'onRequest',
      createAuthHook(authTokenService, { limiter: authFailureLimiter, validateCredential }),
    );
  } else if (opts.disableAuth === true) {
    logger.warn(
      { host, exposureClass },
      'DANGEROUS: bearer-token auth is DISABLED (--dangerous-bypass-auth) — every REST and WebSocket route accepts unauthenticated requests',
    );
  }
  if (exposureClass !== 'loopback') {
    app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
  }

  return {
    host,
    requestedPort,
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
    boundPort: () => currentPort,
    createRemoteControl(readManagedOAuth) {
      const service = createRemoteControlManager({
        homeDir,
        localOrigin: () => `http://${localOriginHost}:${currentPort}`,
        localServerToken: () => authTokenService.getToken(),
        clientVersion: `${opts.hostIdentity.productName}/${opts.hostIdentity.version}`,
        urlSource: opts.hostIdentity.platform,
        configuredOAuthKey: () => readManagedOAuth()?.key,
        configuredOAuthHost: () => readManagedOAuth()?.oauthHost,
        stderr: {
          write: (text) => {
            logger.warn(String(text).trimEnd());
            return true;
          },
        },
      });
      const devices = new RemoteControlDeviceClient({
        homeDir,
        configuredOAuthKey: () => readManagedOAuth()?.key,
        configuredOAuthHost: () => readManagedOAuth()?.oauthHost,
      });
      const staticEnableError =
        opts.socketPath !== undefined
          ? 'Remote Control requires a TCP listener.'
          : exposureClass !== 'loopback'
            ? 'Remote Control requires a loopback host.'
            : opts.disableAuth === true
              ? 'Remote Control cannot be combined with --dangerous-bypass-auth.'
              : undefined;
      return { service, devices, homeDir, staticEnableError };
    },
    installUpgradeGate(canUpgrade, performUpgrade) {
      const handleUpgrade = async (
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
      ): Promise<void> => {
        const url = req.url ?? '';
        if (!canUpgrade(url)) {
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
          const bearerToken = authHeader?.startsWith('Bearer ')
            ? authHeader.slice('Bearer '.length)
            : null;
          const protocolToken = extractWsBearerToken(req.headers['sec-websocket-protocol']);
          const candidate =
            bearerToken !== null && bearerToken.length > 0 ? bearerToken : protocolToken;
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
        await performUpgrade(url, req, socket, head);
      };
      app.server.on('upgrade', (req, socket, head) => {
        void handleUpgrade(req, socket, head).catch((error: unknown) =>
          logger.error({ err: error }, 'ws upgrade handler failed'),
        );
      });
    },
    async listenTcp() {
      await listenWithPortRetry({
        listen: (h, p) => app.listen({ host: h, port: p }),
        host,
        port: requestedPort,
        logger,
      });
      const address = app.server.address();
      currentPort = typeof address === 'object' && address !== null ? address.port : requestedPort;
      await registration.update({ port: currentPort });
      return currentPort;
    },
    installProcessHandlers() {
      process.on('unhandledRejection', onUnhandledRejection);
      process.on('uncaughtException', onUncaughtException);
    },
    removeProcessHandlers() {
      process.off('unhandledRejection', onUnhandledRejection);
      process.off('uncaughtException', onUncaughtException);
    },
  };
}
