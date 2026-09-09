import type { XstateInspectionCollector } from '@moonshot-ai/agent-core-v2/human/xstateInspection';
import { WebSocketServer } from 'ws';

import { selectWsBearerProtocol } from '../bearerProtocol';
import { WsConnectionDebug } from './wsConnectionDebug';

export const WS_DEBUG_PATH = '/api/v1/debug/ws';

export interface RegisterWsDebugOptions {
  readonly collector?: XstateInspectionCollector;
  readonly heartbeatIntervalMs?: number;
  readonly flushIntervalMs?: number;
  readonly highWaterMarkBytes?: number;
}

export function registerWsDebug(opts: RegisterWsDebugOptions = {}): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });
  const connections = new Set<WsConnectionDebug>();

  wss.on('connection', (socket) => {
    const conn = new WsConnectionDebug({
      socket,
      collector: opts.collector,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      flushIntervalMs: opts.flushIntervalMs,
      highWaterMarkBytes: opts.highWaterMarkBytes,
    });
    connections.add(conn);
    socket.on('close', () => {
      connections.delete(conn);
    });
  });

  wss.on('close', () => {
    for (const conn of connections) conn.close();
  });

  return wss;
}
