/**
 * `/api/v1/ws` — creates the v1 (legacy) WebSocket server. The HTTP `upgrade`
 * event is dispatched by the bootstrap (`start.ts`), which routes by path so
 * this endpoint coexists with `/api/v2/ws`.
 *
 * Each connection is a {@link WsConnectionV1}, tracked in the shared
 * {@link IConnectionRegistry}; shutdown (close-all + wss.close) is owned by the
 * bootstrap.
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';
import { WebSocketServer } from 'ws';

import type { CredentialValidator } from '../../../services/auth/credentials';
import { type IConnectionRegistry } from '../connectionRegistry';
import type { SessionEventBroadcaster } from './sessionEventBroadcaster';
import type { FsWatchBridge } from './fsWatchBridge';
import type { JournalLogger } from './sessionEventJournal';
import { WsConnectionV1 } from './wsConnectionV1';
import { selectWsBearerProtocol } from '../bearerProtocol';

export const WS_PATH = '/api/v1/ws';

export interface RegisterWsV1Options {
  /** Present-only credential validator forwarded to {@link WsConnectionV1}. */
  readonly validateCredential?: CredentialValidator;
  readonly registry: IConnectionRegistry;
  readonly broadcaster: SessionEventBroadcaster;
  readonly fsWatchBridge: FsWatchBridge;
  readonly logger?: JournalLogger;
  readonly maxBufferSize?: number;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly highWaterMarkBytes?: number;
}

export function registerWsV1(core: Scope, opts: RegisterWsV1Options): WebSocketServer {
  void core; // the broadcaster already holds the Core scope
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });
  const { registry, broadcaster } = opts;

  wss.on('connection', (socket, req) => {
    const conn = new WsConnectionV1({
      socket,
      broadcaster,
      fsWatchBridge: opts.fsWatchBridge,
      connectionRegistry: registry,
      validateCredential: opts.validateCredential,
      remoteAddress: req.socket.remoteAddress ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      logger: opts.logger,
      maxBufferSize: opts.maxBufferSize,
      flushIntervalMs: opts.flushIntervalMs,
      maxBatchSize: opts.maxBatchSize,
      highWaterMarkBytes: opts.highWaterMarkBytes,
    });
    socket.on('close', () => registry.remove(conn.id));
  });

  return wss;
}
