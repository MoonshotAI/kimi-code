import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';

import {
  ProviderConfigSchema,
  PROVIDERS_SECTION,
  providersFromToml,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import type { FastifyInstance } from 'fastify';
import { parse as parseToml } from 'smol-toml';

import { okEnvelope } from './envelope';
import {
  prepareHttpShell,
  type HttpEndpointOptions,
  type ManagedOAuthRef,
} from './httpShell';
import { createAsyncApiDocument } from './protocol/asyncapi';
import {
  INTERNAL_SKIP_RC_LOGOUT_GATE_HEADER,
  registerOAuthLogoutRoute,
} from './routes/oauth';
import { registerRemoteControlRoutes } from './routes/remoteControl';
import { registerShutdownRoutes } from './routes/shutdown';
import { registerWebAssetRoutes } from './routes/webAssets';
import type { IAuthTokenService } from './services/auth/authTokenService';
import {
  forwardHttpToSession,
  forwardWebSocketToSession,
  matchHostProxyPath,
  sendHostSessionError,
} from './services/hosts/hostProxy';
import { HostRequestError, type HostSession } from './services/hosts/hostSession';
import { StdioHostSession } from './services/hosts/stdioHostSession';
import type { ServerHostIdentity } from './start';
import { WS_PATH as WS_PATH_V1 } from './transport/ws/v1/registerWsV1';

export interface WebGatewayStartOptions extends HttpEndpointOptions {
  readonly daemonStream: Duplex;
  readonly reconnectDaemon?: () => Promise<Duplex>;
  readonly onShutdownRequest?: () => void;
  readonly hostIdentity: ServerHostIdentity;
}

export interface RunningWebGateway {
  readonly app: FastifyInstance;
  readonly authTokenService: IAuthTokenService;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

function readConfiguredOAuthFromConfigFile(configPath: string): ManagedOAuthRef | undefined {
  try {
    const parsed = parseToml(readFileSync(configPath, 'utf8'));
    const converted = providersFromToml(parsed[PROVIDERS_SECTION]);
    if (converted === null || typeof converted !== 'object') return undefined;
    const entry = ProviderConfigSchema.safeParse(
      (converted as Record<string, unknown>)[KIMI_CODE_PROVIDER_NAME],
    );
    return entry.success ? entry.data.oauth : undefined;
  } catch {
    return undefined;
  }
}

function isBlockedGatewayProxyPath(rawPathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return true;
  }
  for (const candidate of [rawPathname, decoded]) {
    if (
      candidate === '/api/v1/shutdown' ||
      candidate === '/api/v1/hosts:import-providers' ||
      candidate === '/api/v1/oauth/logout' ||
      candidate === '/api/v1/remote-control' ||
      candidate.startsWith('/api/v1/remote-control/') ||
      candidate === '/api/v1/debug' ||
      candidate.startsWith('/api/v1/debug/')
    ) {
      return true;
    }
  }
  return false;
}

export async function startWebGateway(opts: WebGatewayStartOptions): Promise<RunningWebGateway> {
  const shell = await prepareHttpShell(opts);
  const {
    host,
    configPath,
    serverVersion,
    enableShutdown,
    logger,
    registration,
    authTokenService,
    authFailureLimiter,
    app,
  } = shell;
  const startedAt = new Date().toISOString();
  const product =
    opts.hostIdentity.productName.length > 0 ? opts.hostIdentity.productName : undefined;

  let closing = false;
  let closePromise: Promise<void> | undefined;
  let currentStream: Duplex = opts.daemonStream;
  let currentSession = new StdioHostSession(opts.daemonStream);
  let reconnecting: Promise<StdioHostSession> | undefined;
  const activeWsClosers = new Set<() => void>();

  const resolveGatewaySession = async (): Promise<HostSession> => {
    if (!closing && currentSession.isClosed && opts.reconnectDaemon !== undefined) {
      reconnecting ??= opts
        .reconnectDaemon()
        .then((nextStream) => {
          if (closing) {
            nextStream.destroy();
            throw new HostRequestError('unavailable', 'gateway is shutting down');
          }
          currentStream.destroy();
          currentStream = nextStream;
          currentSession = new StdioHostSession(nextStream);
          return currentSession;
        })
        .finally(() => {
          reconnecting = undefined;
        });
      return reconnecting;
    }
    return currentSession;
  };

  const remoteControl = shell.createRemoteControl(() =>
    readConfiguredOAuthFromConfigFile(configPath),
  );

  const performClose = async (): Promise<void> => {
    closing = true;
    for (const closeWs of activeWsClosers) closeWs();
    activeWsClosers.clear();
    await remoteControl.service.close();
    currentSession.close();
    currentStream.destroy();
    await app.close();
    authFailureLimiter?.dispose();
    try {
      await registration.release();
    } finally {
      shell.removeProcessHandlers();
    }
  };

  const close = (): Promise<void> => {
    closePromise ??= performClose();
    return closePromise;
  };

  const requestClose = (): void => {
    if (opts.onShutdownRequest !== undefined) {
      opts.onShutdownRequest();
      return;
    }
    void close().catch((error: unknown) => logger.error({ err: error }, 'gateway close failed'));
  };

  await app.register(
    async (apiV1) => {
      apiV1.get('/meta', async (req, reply) => {
        try {
          const session = await resolveGatewaySession();
          const upstream = await session.request({
            method: 'GET',
            path: '/api/v1/meta',
            headers: { host: '127.0.0.1', 'x-request-id': req.id },
          });
          if (upstream.status !== 200) {
            return await reply.code(upstream.status).type('application/json').send(upstream.body);
          }
          const envelope = JSON.parse(upstream.body.toString('utf8')) as {
            data?: Record<string, unknown>;
          };
          const nextData: Record<string, unknown> = {
            ...envelope.data,
            server_id: registration.serverId,
            started_at: startedAt,
            product,
            dangerous_bypass_auth: opts.disableAuth === true,
          };
          if (opts.webTitle !== undefined) {
            nextData['web_title'] = opts.webTitle;
          } else {
            delete nextData['web_title'];
          }
          return await reply.send(okEnvelope(nextData, req.id));
        } catch (error) {
          await sendHostSessionError(reply, req.id, error);
          return;
        }
      });

      registerRemoteControlRoutes(
        apiV1 as unknown as Parameters<typeof registerRemoteControlRoutes>[0],
        remoteControl,
      );

      registerOAuthLogoutRoute(
        apiV1 as unknown as Parameters<typeof registerOAuthLogoutRoute>[0],
        {
          remoteControl: remoteControl.service,
          remoteControlDevices: remoteControl.devices,
          homeDir: shell.homeDir,
          logout: async (provider) => {
            const session = await resolveGatewaySession();
            const payload = Buffer.from(JSON.stringify(provider === undefined ? {} : { provider }));
            const response = await session.request({
              method: 'POST',
              path: '/api/v1/oauth/logout',
              headers: {
                host: '127.0.0.1',
                'content-type': 'application/json',
                [INTERNAL_SKIP_RC_LOGOUT_GATE_HEADER]: '1',
              },
              body: payload,
              timeoutMs: 0,
            });
            const parsed = JSON.parse(response.body.toString('utf8')) as {
              code?: number;
              msg?: string;
              data?: unknown;
            };
            if (response.status !== 200 || parsed.code !== 0) {
              throw new Error(parsed.msg ?? `OAuth logout failed (${String(response.status)})`);
            }
            return parsed.data;
          },
        },
      );

      if (enableShutdown) {
        registerShutdownRoutes(
          apiV1 as unknown as Parameters<typeof registerShutdownRoutes>[0],
          {
            onShutdown: requestClose,
            drainIdleSessions: async () => activeWsClosers.size === 0,
          },
        );
      }
    },
    { prefix: '/api/v1' },
  );

  await app.register(async (proxyScope) => {
    proxyScope.removeAllContentTypeParsers();
    proxyScope.addContentTypeParser('*', (_req, payload, done) => {
      done(null, payload);
    });
    for (const url of ['/api/v1/*', '/openapi.json']) {
      proxyScope.route({
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
        url,
        handler: async (req, reply) => {
          const rawUrl = req.raw.url ?? req.url;
          const pathname = rawUrl.split('?', 1)[0] ?? rawUrl;
          if (isBlockedGatewayProxyPath(pathname)) {
            return reply.callNotFound();
          }
          let session: HostSession;
          try {
            session = await resolveGatewaySession();
          } catch (error) {
            await sendHostSessionError(reply, req.id, error);
            return;
          }
          await forwardHttpToSession(session, rawUrl, req, reply, { timeoutMs: 0 });
        },
      });
    }
  });

  app.get('/asyncapi.json', async (_req, reply) => {
    return reply
      .type('application/json')
      .send(createAsyncApiDocument({ version: serverVersion, serverHost: host }));
  });

  shell.installUpgradeGate(
    (url) =>
      url === WS_PATH_V1 ||
      url.startsWith(`${WS_PATH_V1}?`) ||
      matchHostProxyPath(url) !== undefined,
    async (url, req, socket, head) => {
      let session: HostSession;
      try {
        session = await resolveGatewaySession();
      } catch {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (closing) {
        socket.destroy();
        return;
      }
      let registeredCloser: (() => void) | undefined;
      forwardWebSocketToSession(session, url, req, socket, head, {
        onOpen: (closeSocket) => {
          if (closing) {
            closeSocket();
            return;
          }
          registeredCloser = closeSocket;
          activeWsClosers.add(closeSocket);
        },
        onClose: () => {
          if (registeredCloser !== undefined) activeWsClosers.delete(registeredCloser);
        },
      });
    },
  );

  if (opts.webAssetsDir !== undefined) {
    await registerWebAssetRoutes(app, opts.webAssetsDir);
  }

  let boundPort = 0;
  try {
    boundPort = await shell.listenTcp();
  } catch (error) {
    try {
      await close();
    } catch {}
    throw error;
  }

  shell.installProcessHandlers();

  return {
    app,
    authTokenService,
    host,
    port: boundPort,
    close,
  };
}
