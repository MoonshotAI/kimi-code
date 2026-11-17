import type { Scope } from '@moonshot-ai/agent-core-v2';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';

import { getRequestPrincipal } from '../../../middleware/auth';
import { type IConnectionRegistry } from '../connectionRegistry';
import type { SessionEventBroadcaster } from './sessionEventBroadcaster';
import { createTaskSource } from './taskRequests';
import { WsConnectionV1 } from './wsConnectionV1';
import { selectWsBearerProtocol } from '../bearerProtocol';

export const WS_PATH = '/api/v1/ws';

export interface RegisterWsV1Options {
  readonly registry: IConnectionRegistry;
  readonly broadcaster: SessionEventBroadcaster;
  readonly onOwnerConnected?: (target: WsConnectionV1) => void;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly highWaterMarkBytes?: number;
  readonly heartbeatIntervalMs?: number;
}

export function registerWsV1(core: Scope, opts: RegisterWsV1Options): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });
  const { registry, broadcaster } = opts;
  const taskSource = createTaskSource(core);

  wss.on('connection', (socket, req: IncomingMessage) => {
    const principal = getRequestPrincipal(req);
    const conn = new WsConnectionV1({
      socket,
      broadcaster,
      taskSource,
      connectionRegistry: registry,
      remoteAddress: req.socket.remoteAddress ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      principal,
      flushIntervalMs: opts.flushIntervalMs,
      maxBatchSize: opts.maxBatchSize,
      highWaterMarkBytes: opts.highWaterMarkBytes,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
    });
    if (conn.role === 'owner') {
      opts.onOwnerConnected?.(conn);
    }
    socket.on('close', () => registry.remove(conn.id));
  });

  return wss;
}
