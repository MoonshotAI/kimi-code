import type { Scope } from '@moonshot-ai/agent-core-v2';
import { WebSocketServer } from 'ws';

import type { CredentialValidator } from '../../../services/auth/credentials';
import { type IConnectionRegistry } from '../connectionRegistry';
import type { SessionEventBroadcaster } from './sessionEventBroadcaster';
import { createTaskSource } from './taskRequests';
import { WsConnectionV1 } from './wsConnectionV1';
import { selectWsBearerProtocol } from '../bearerProtocol';

export const WS_PATH = '/api/v1/ws';

export interface RegisterWsV1Options {
  readonly validateCredential?: CredentialValidator;
  readonly registry: IConnectionRegistry;
  readonly broadcaster: SessionEventBroadcaster;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly highWaterMarkBytes?: number;
  readonly heartbeatIntervalMs?: number;
}

export function registerWsV1(core: Scope, opts: RegisterWsV1Options): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });
  const { registry, broadcaster } = opts;
  const taskSource = createTaskSource(core);

  wss.on('connection', (socket, req) => {
    const conn = new WsConnectionV1({
      socket,
      broadcaster,
      taskSource,
      connectionRegistry: registry,
      validateCredential: opts.validateCredential,
      remoteAddress: req.socket.remoteAddress ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      flushIntervalMs: opts.flushIntervalMs,
      maxBatchSize: opts.maxBatchSize,
      highWaterMarkBytes: opts.highWaterMarkBytes,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
    });
    socket.on('close', () => registry.remove(conn.id));
  });

  return wss;
}
