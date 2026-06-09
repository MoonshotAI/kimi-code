/**
 * `WSGateway` — implementation of `IWSGateway`.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { Disposable } from '@moonshot-ai/agent-core';
import { WebSocketServer, type WebSocket } from 'ws';

import { IConnectionRegistry } from './connectionRegistry';
import { ILogService } from '#/services/logger';
import { IRestGateway } from './restGateway';
import { ISessionClientsService } from './sessionClients';
import { IWSBroadcastService } from './wsBroadcast';
import { IWSGateway, type WSGatewayOptions, WS_PATH } from './wsGateway';
import { WsConnection, type AbortHandler, type FsWatchHandler } from '#/ws/connection';

export class WSGateway extends Disposable implements IWSGateway {
  readonly _serviceBrand: undefined;

  private readonly wss: WebSocketServer;
  private readonly upgradeListener: (req: IncomingMessage, sock: Socket, head: Buffer) => void;
  private readonly server: HttpServer;
  private abortHandler: AbortHandler | undefined;
  private fsWatchHandler: FsWatchHandler | undefined;
  private detached = false;

  constructor(
    // VSCode-style ctor ordering — static-first, services-last with
    // `@I*` decorators. `options` follows the static prefix; the four
    // injected services trail. `@IWSBroadcastService` is the daemon-local
    // transport service that holds the ring buffer + replay queries used
    // by `WsConnection` during `client_hello.last_seq_by_session` replay
    // and by the WS abort ack to populate `at_seq`.
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

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    // Restrict to `/api/v1/ws` (with optional query string per WS.md §1.1).
    const url = req.url ?? '';
    const path = url.split('?', 1)[0];
    if (path !== WS_PATH) {
      // Other Fastify routes don't use WS; politely drop the handshake.
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws));
  }

  private onConnect(socket: WebSocket): void {
    const conn = new WsConnection({
      socket,
      logger: this.logger,
      sessionClients: this.sessionClients,
      wsBroadcast: this.wsBroadcast,
      ...(this.abortHandler !== undefined ? { abortHandler: this.abortHandler } : {}),
      ...(this.fsWatchHandler !== undefined ? { fsWatchHandler: this.fsWatchHandler } : {}),
      ...(this.options.pingIntervalMs !== undefined
        ? { pingIntervalMs: this.options.pingIntervalMs }
        : {}),
      ...(this.options.pongTimeoutMs !== undefined
        ? { pongTimeoutMs: this.options.pongTimeoutMs }
        : {}),
    });
    this.registry.add(conn);
    socket.on('close', () => this.registry.remove(conn.id));
  }

  get size(): number {
    return this.registry.size();
  }

  override dispose(): void {
    if (this._isDisposed) return;
    // 1. Close every attached connection (WS code 1001 = going away).
    try {
      this.registry.closeAll('daemon shutting down');
    } catch {
      // continue teardown
    }
    // 2. Stop accepting new handshakes.
    try {
      this.wss.close();
    } catch {
      // continue
    }
    // 3. Detach upgrade listener so the raw http.Server's `close()` (run
    //    earlier by RunningDaemon.close → app.close → server.close) doesn't
    //    still funnel into us. Defensive — if the server is already shut down
    //    `off` is a no-op.
    if (!this.detached) {
      try {
        this.server.off('upgrade', this.upgradeListener);
      } catch {
        // ignore
      }
      this.detached = true;
    }
    super.dispose();
  }
}
