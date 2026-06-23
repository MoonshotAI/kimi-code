import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { Disposable, ILogService } from '@moonshot-ai/agent-core';
import { WebSocketServer, type WebSocket } from 'ws';

import { isAllowedHost } from '#/middleware/hostnames';
import { isOriginAllowed } from '#/middleware/origin';
import type { IAuthTokenService } from '#/services/auth/authTokenService';
import {
  WsConnection,
  type AbortHandler,
  type FsWatchHandler,
  type TerminalHandler,
} from '#/ws/connection';

import { IConnectionRegistry } from './connectionRegistry';
import { IRestGateway } from './restGateway';
import { ISessionClientsService } from './sessionClients';
import { IWSBroadcastService } from './wsBroadcast';
import {
  extractWsBearerToken,
  IWSGateway,
  type WSGatewayOptions,
  WS_BEARER_PROTOCOL_PREFIX,
  WS_PATH,
} from './wsGateway';

export class WSGateway extends Disposable implements IWSGateway {
  readonly _serviceBrand: undefined;

  private readonly wss: WebSocketServer;
  private readonly upgradeListener: (req: IncomingMessage, sock: Socket, head: Buffer) => void;
  private readonly server: HttpServer;
  private abortHandler: AbortHandler | undefined;
  private fsWatchHandler: FsWatchHandler | undefined;
  private terminalHandler: TerminalHandler | undefined;
  private authTokenService: IAuthTokenService | undefined;
  private detached = false;

  constructor(
    private readonly options: WSGatewayOptions,
    @IWSBroadcastService private readonly wsBroadcast: IWSBroadcastService,
    @IRestGateway private readonly restGateway: IRestGateway,
    @IConnectionRegistry private readonly registry: IConnectionRegistry,
    @ISessionClientsService private readonly sessionClients: ISessionClientsService,
    @ILogService private readonly logger: ILogService,
  ) {
    super();
    this.authTokenService = options.authTokenService;
    this.wss = new WebSocketServer({
      noServer: true,
      // Browsers require the server to select one of the offered subprotocols;
      // echo back the `kimi-code.bearer.<token>` subprotocol when present so
      // token-carrying browser clients complete the handshake.
      handleProtocols: (protocols: Set<string>) => {
        for (const p of protocols) {
          if (p.startsWith(WS_BEARER_PROTOCOL_PREFIX)) return p;
        }
        return false;
      },
    });
    this.server = this.restGateway.app.server;
    this.upgradeListener = (req, sock, head) => {
      void this.onUpgrade(req, sock, head);
    };
    this.server.on('upgrade', this.upgradeListener);
    this.logger.debug({ path: WS_PATH }, 'ws gateway attached upgrade listener');
  }

  setAbortHandler(handler: AbortHandler): void {
    this.abortHandler = handler;
  }

  setFsWatchHandler(handler: FsWatchHandler): void {
    this.fsWatchHandler = handler;
  }

  setTerminalHandler(handler: TerminalHandler): void {
    this.terminalHandler = handler;
  }

  setAuthTokenService(service: IAuthTokenService): void {
    this.authTokenService = service;
  }

  private async onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = req.url ?? '';
    const path = url.split('?', 1)[0];
    if (path !== WS_PATH) {
      socket.destroy();
      return;
    }
    // Disable Nagle's algorithm: streaming chat sends many small frames (one per
    // token delta), and Nagle + the client's delayed ACK can bunch them into
    // ~40 ms clusters, making the stream look stuttery. Trade a little bandwidth
    // for lower latency.
    socket.setNoDelay(true);

    // Host / Origin checks (ROADMAP M4.3) — enforced BEFORE token validation
    // and only when the corresponding option is provided. When unset (tests /
    // pre-M5.1 boots) the checks are skipped so existing clients (incl. Node
    // `ws`, which sends no `Origin`) keep working. Origin is present-only: a
    // missing `Origin` is treated as a non-browser client and allowed.
    const hostCheck = this.options.hostCheck;
    if (hostCheck !== undefined && !isAllowedHost(req.headers.host, hostCheck)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const allowedOrigins = this.options.allowedOrigins;
    if (
      allowedOrigins !== undefined &&
      !isOriginAllowed(req.headers.origin, req.headers.host, allowedOrigins)
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const authTokenService = this.authTokenService;
    if (authTokenService !== undefined) {
      const authorization = req.headers.authorization;
      const token = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : extractWsBearerToken(req.headers['sec-websocket-protocol']);
      // `isValid` is the only await on this path; wrap it so a rejection
      // destroys the socket instead of escaping as an unhandled rejection.
      let ok = false;
      try {
        ok = token !== undefined && (await authTokenService.isValid(token));
      } catch {
        ok = false;
      }
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws, req));
  }

  private onConnect(socket: WebSocket, req: IncomingMessage): void {
    const remoteAddress = req.socket.remoteAddress ?? null;
    const userAgent = req.headers['user-agent'] ?? null;
    const conn = new WsConnection({
      socket,
      logger: this.logger,
      remoteAddress,
      userAgent,
      sessionClients: this.sessionClients,
      wsBroadcast: this.wsBroadcast,
      ...(this.abortHandler !== undefined ? { abortHandler: this.abortHandler } : {}),
      ...(this.fsWatchHandler !== undefined ? { fsWatchHandler: this.fsWatchHandler } : {}),
      ...(this.terminalHandler !== undefined ? { terminalHandler: this.terminalHandler } : {}),
      ...(this.options.pingIntervalMs !== undefined
        ? { pingIntervalMs: this.options.pingIntervalMs }
        : {}),
      ...(this.options.pongTimeoutMs !== undefined
        ? { pongTimeoutMs: this.options.pongTimeoutMs }
        : {}),
    });
    this.registry.add(conn);
    this.options.onConnectionCountChange?.(this.registry.size());

    const connectedAt = Date.now();
    this.options.telemetry?.track('ws_connected', {
      connection_id: conn.id,
      connection_count: this.registry.size(),
    });

    socket.on('close', () => {
      this.registry.remove(conn.id);
      this.options.onConnectionCountChange?.(this.registry.size());
      this.options.telemetry?.track('ws_disconnected', {
        connection_id: conn.id,
        connection_count: this.registry.size(),
        duration_ms: Date.now() - connectedAt,
      });
    });
  }

  get size(): number {
    return this.registry.size();
  }

  override dispose(): void {
    if (this._store.isDisposed) return;

    try {
      this.registry.closeAll('server shutting down');
    } catch {}

    try {
      this.wss.close();
    } catch {}

    if (!this.detached) {
      try {
        this.server.off('upgrade', this.upgradeListener);
      } catch {}
      this.detached = true;
    }
    super.dispose();
  }
}
