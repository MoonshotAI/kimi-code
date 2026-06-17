import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { Disposable, ILogService } from '@moonshot-ai/agent-core';
import { WebSocketServer, type WebSocket } from 'ws';

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
import { IWSGateway, type WSGatewayOptions, WS_PATH } from './wsGateway';

export class WSGateway extends Disposable implements IWSGateway {
  readonly _serviceBrand: undefined;

  private readonly wss: WebSocketServer;
  private readonly upgradeListener: (req: IncomingMessage, sock: Socket, head: Buffer) => void;
  private readonly server: HttpServer;
  private abortHandler: AbortHandler | undefined;
  private fsWatchHandler: FsWatchHandler | undefined;
  private terminalHandler: TerminalHandler | undefined;
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
    this.wss = new WebSocketServer({ noServer: true });
    this.server = this.restGateway.app.server;
    this.upgradeListener = (req, sock, head) => this.onUpgrade(req, sock, head);
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

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = req.url ?? '';
    const path = url.split('?', 1)[0];
    if (path !== WS_PATH) {
      socket.destroy();
      return;
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
